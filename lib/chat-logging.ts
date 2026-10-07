import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseAdminConfigured } from "@/lib/supabase/config";

type Citation = { fileId: string; filename: string };

type ChatLog = {
  municipalityId: string | null;
  conversationId?: string;
  anonymousSessionId?: string;
  question: string;
  answer: string;
  citations: Citation[];
  requestId: string;
  model: string;
};

export async function logChatExchange(input: ChatLog): Promise<{ conversationId?: string }> {
  if (!input.municipalityId || !isSupabaseAdminConfigured()) return {};

  try {
    const supabase = createAdminClient();
    let conversationId = input.conversationId;

    if (conversationId) {
      const { data } = await supabase
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("municipality_id", input.municipalityId)
        .maybeSingle();
      conversationId = data?.id;
    }

    if (!conversationId) {
      const { data, error } = await supabase
        .from("conversations")
        .insert({
          municipality_id: input.municipalityId,
          anonymous_session_id: input.anonymousSessionId || null,
        })
        .select("id")
        .single();
      if (error) throw error;
      conversationId = data.id;
    }

    const { error: messagesError } = await supabase.from("messages").insert([
      { conversation_id: conversationId, role: "user", content: input.question },
      {
        conversation_id: conversationId,
        role: "assistant",
        content: input.answer,
        request_id: input.requestId,
        model: input.model,
      },
    ]);
    if (messagesError) throw messagesError;

    const { data: assistantMessage, error: messageError } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("request_id", input.requestId)
      .single();
    if (messageError) throw messageError;

    if (input.citations.length) {
      const { error: citationsError } = await supabase.from("citations").insert(
        input.citations.map((citation, index) => ({
          message_id: assistantMessage.id,
          file_id: citation.fileId,
          filename: citation.filename,
          ordinal: index + 1,
        }))
      );
      if (citationsError) throw citationsError;
    }

    await supabase
      .from("conversations")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", conversationId);

    return { conversationId };
  } catch (error) {
    console.error(`[${input.requestId}] Failed to save chat analytics.`, error);
    return {};
  }
}
