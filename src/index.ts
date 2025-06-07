import PostalMime from "postal-mime";
import OpenAI from "openai";
import { z } from "zod";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return new Response("Hello World!");
  },

  async email(message, env, ctx) {
    const email = await PostalMime.parse(message.raw, {
      attachmentEncoding: "arraybuffer",
    });
  },
} satisfies ExportedHandler<Env>;
