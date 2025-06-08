import PostalMime from "postal-mime";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { createMimeMessage } from "mimetext";
import { EmailMessage } from "cloudflare:email";

const Classification = z.object({
  isReceipt: z.boolean(),
  receipt: z.object({
    dateYYYYMMDD: z.string(),
    nameOfCompany: z.string(),
    totalAmount: z.string(),
    currency: z.enum(["USD", "JPY", "unknown"]),
    invoiceOrReceiptFullAttachmentFileName: z.string(),
    category: z.enum(["Travel", "Equipment", "Services", "SAAS"]),
    lineItems: z.array(
      z.object({
        amount: z.string(),
        quantity: z.number(),
        nameOfProduct: z.string(),
      })
    ),
  }),
});
type ReceiptResult = z.output<typeof Classification>;

const ExchangeRates = z.object({
  records: z.array(
    z.object({
      id: z.string(),
      fields: z.object({
        Date: z.string(),
        "JPY per USD": z.number(),
      }),
    })
  ),
});

export default {
  async fetch(_request, _env, _ctx): Promise<Response> {
    return new Response("Nothing to see here");
  },

  async email(message, env, _ctx) {
    const id = `${Date.now()}-${crypto.randomUUID().split("-")[0]}`;

    const openai = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
    });

    const email = await PostalMime.parse(message.raw, {
      attachmentEncoding: "base64",
    });

    const emailBody = email.html ?? email.text;
    if (!emailBody) {
      console.warn("Received empty email from", email.from);
      return;
    }

    const attachmentUploads = [];

    const attachments: Array<{ type: "input_file"; filename: string; file_data: string }> = [];
    for (const attachment of email.attachments) {
      const data = `data:${attachment.mimeType};base64,${attachment.content}`;

      const bytes = Uint8Array.from(atob(attachment.content as string), (c) => c.charCodeAt(0));
      attachmentUploads.push(env.RECEIPTS.put(`${id}/${attachment.filename ?? "attachment"}`, bytes));

      attachments.push({
        type: "input_file",
        filename: attachment.filename ?? attachment.mimeType,
        file_data: data,
      });
    }

    const response = await openai.responses.parse({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: "Determine whether this email is a receipt or not, and extract its line items.",
        },
        {
          role: "user",
          content: [
            ...attachments,
            {
              type: "input_text",
              text: emailBody,
            },
            {
              type: "input_text",
              text: `Attachments: ${attachments.map((a) => a.filename).join(", ")}`,
            },
          ],
        },
      ],
      text: {
        format: zodTextFormat(Classification, "receipt"),
      },
    });

    const result = response.output_parsed;

    if (!result) {
      throw new Error("Empty openai response.");
    }
    console.log(result);
    if (!result.isReceipt) {
      console.warn("Not a receipt. Carry on.");
      return;
    }
    if (!result.receipt) {
      throw new Error("Somehow isReceipt is false but receipt is null?");
    }

    const airtableResult = await addToAirtable(result, id, env).catch((e) => {
      console.error(e);
      return { error: e.toString() };
    });

    const reply = createMimeMessage();
    const messageId = message.headers.get("Message-ID");
    if (messageId) {
      reply.setHeader("In-Reply-To", messageId);
    }
    const sender = { name: "Receipter", addr: env.EMAIL_ADDRESS };
    reply.setSender(sender);
    reply.setSubject(`Re: ${email.subject ?? "recent email"}`);

    const r = result.receipt;
    const textLines: string[] = [
      `Receipt for: ${r.nameOfCompany} (${r.dateYYYYMMDD})`,
      `Total: ${r.totalAmount} ${r.currency}`,
      ...r.lineItems.map((item) => `${item.nameOfProduct}: ${item.amount} x${item.quantity}`),
      `Airtable result: ${JSON.stringify(airtableResult)}`,
    ];

    let resultHTML: string;
    if ("recordID" in airtableResult) {
      const paths = env.AIRTABLE_BASE_PATH.split("/");
      const baseID = paths[paths.length - 1];
      const url = `https://airtable.com/${baseID}/${airtableResult.recordID}`;

      resultHTML = `<a href=${url}>${url}</a>`;
    } else if ("error" in airtableResult) {
      resultHTML = `<pre style'color: red'>${airtableResult.error}</pre>`;
    } else {
      resultHTML = "<span style'color: red'>something is wrong</span>";
    }

    const html: string = `
      <h1>${r.nameOfCompany} (${r.dateYYYYMMDD})</h1>

      <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
        <thead>
          <tr style="background-color: #f5f5f5;">
            <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Product</th>
            <th style="border: 1px solid #ddd; padding: 8px; text-align: right;">Amount</th>
            <th style="border: 1px solid #ddd; padding: 8px; text-align: right;">Quantity</th>
            <th style="border: 1px solid #ddd; padding: 8px; text-align: right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${r.lineItems
            .map(
              (item) => `
            <tr>
              <td style="border: 1px solid #ddd; padding: 8px;">${item.nameOfProduct}</td>
              <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${item.amount} ${r.currency}</td>
              <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${item.quantity}</td>
              <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${(parseFloat(item.amount) * item.quantity).toFixed(2)} ${r.currency}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
        <tfoot>
          <tr style="background-color: #f9f9f9; font-weight: bold;">
            <td colspan="3" style="border: 1px solid #ddd; padding: 8px; text-align: right;">Total:</td>
            <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${r.totalAmount} ${r.currency}</td>
          </tr>
        </tfoot>
      </table>

      ${resultHTML}
    `;

    reply.addMessage({
      contentType: "text/plain",
      data: textLines.join("\n\n"),
    });
    reply.addMessage({
      contentType: "text/html",
      data: html,
    });

    await message.reply(new EmailMessage(sender.addr, message.from, reply.asRaw()));
    await Promise.all(attachmentUploads);
  },
} satisfies ExportedHandler<Env>;

type Result =
  | {
      error: string;
    }
  | {
      recordID: string;
    };

async function addToAirtable(result: ReceiptResult, id: string, env: Env): Promise<Result> {
  const baseURL = "https://api.airtable.com";
  const basePath = env.AIRTABLE_BASE_PATH;
  const { receipt } = result;
  const authorization = `Bearer ${env.AIRTABLE_API_KEY}`;

  if (receipt.currency === "unknown") {
    return { error: "unknown currency" };
  }

  // fetch exchange rate for date
  const ratesURL = new URL(baseURL);
  ratesURL.pathname = `${basePath}/Exchange Rate`;
  ratesURL.searchParams.append("maxRecords", "1");
  ratesURL.searchParams.append("maxRecords", "100");
  ratesURL.searchParams.append("sort[0][field]", "Date");
  ratesURL.searchParams.append("sort[0][direction]", "desc");
  const ratesRaw = await fetch(ratesURL, { method: "GET", headers: { authorization } }).then((x) => x.json());
  const rates = ExchangeRates.parse(ratesRaw);
  const rate = rates.records.find((x) => x.fields.Date === receipt.dateYYYYMMDD);
  if (!rate) {
    return { error: `No rate found for ${receipt.dateYYYYMMDD}` };
  }

  const uploadsBase = env.UPLOADS_URL.replace(/\/$/, "");
  const receiptUrl = `${uploadsBase}/${id}/${receipt.invoiceOrReceiptFullAttachmentFileName}`;

  // create entry
  // https://airtable.com/appUQFzJEsSST1Nkt/api/docs#curl/table:receipt%20log:create
  const createRequest = {
    records: [
      {
        fields: {
          "Short Description": receipt.nameOfCompany,
          Date: [rate.id],
          [receipt.currency]: parseFloat(receipt.totalAmount.replace(/[^0-9.]/g, "")),
          Category: receipt.category,
          Notes: receipt.lineItems.map((i) => i.nameOfProduct).join("\n"),
          "Receipt Photo": [{ url: receiptUrl }],
        },
      },
    ],
  };
  const receiptsURL = new URL(baseURL);
  receiptsURL.pathname = `${basePath}/Receipt Log`;
  const receiptsResponse = await fetch(receiptsURL, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(createRequest),
  });
  if (receiptsResponse.status !== 200) {
    const body = await receiptsResponse.text();
    console.error(receiptsResponse.status, body);
    return { error: "failed to create expense tracking entry" };
  }

  const body = (await receiptsResponse.json()) as any;

  return { recordID: body.records[0].id };
}
