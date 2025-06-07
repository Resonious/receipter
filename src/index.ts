import PostalMime from "postal-mime";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { createMimeMessage } from "mimetext";
import { EmailMessage } from "cloudflare:email";

const Classification = z.object({
  isReceipt: z.boolean(),
  receipt: z.object({
    date: z.string(),
    nameOfCompany: z.string(),
    totalAmount: z.string(),
    currency: z.string(),
    lineItems: z.array(
      z.object({
        amount: z.string(),
        quantity: z.number(),
        nameOfProduct: z.string(),
      })
    ),
  }),
});

export default {
  async fetch(_request, _env, _ctx): Promise<Response> {
    return new Response("Nothing to see here");
  },

  async email(message, env, _ctx) {
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

    const attachments: Array<{ type: "input_file"; filename: string; file_data: string }> = [];
    for (const attachment of email.attachments) {
      const data = `data:${attachment.mimeType};base64,${attachment.content}`;

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
          ],
        },
      ],
      text: {
        format: zodTextFormat(Classification, "receipt"),
      },
    });

    const result = response.output_parsed;

    if (!result) {
      console.error("Empty openai response. TODO: use workflow to retry?");
      return;
    }
    console.log(result);
    if (!result.isReceipt) {
      console.warn("Not a receipt. Carry on.");
      return;
    }
    if (!result.receipt) {
      console.warn("Somehow isReceipt is false but receipt is null?");
      return;
    }

    const reply = createMimeMessage();
    const messageId = message.headers.get("Message-ID");
    if (messageId) {
      reply.setHeader("In-Reply-To", messageId);
    }
    const sender = { name: "Receipter", addr: "receipts@snd.one" };
    reply.setSender(sender);
    reply.setSubject(`Re: ${email.subject ?? "recent email"}`);

    const r = result.receipt;
    const lines: string[] = [
      `Receipt for: ${r.nameOfCompany} (${r.date})`,
      `Total: ${r.totalAmount} ${r.currency}`,
      ...r.lineItems.map((item) => `${item.nameOfProduct}: ${item.amount} x${item.quantity}`),
    ];

    reply.addMessage({
      contentType: "text/plain",
      data: lines.join("\n\n"),
    });

    await message.reply(new EmailMessage(sender.addr, message.from, reply.asRaw()));
  },
} satisfies ExportedHandler<Env>;
