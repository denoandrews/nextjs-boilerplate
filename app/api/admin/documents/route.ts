import OpenAI from "openai";
import { getAdminContext } from "@/lib/admin-auth";
import { safeStorageFilename, validateDocumentInput } from "@/lib/document-validation";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function reply(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const context = await getAdminContext();
  if (!context) return reply({ error: "Unauthorized." }, 401);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, document_type, status, created_at, updated_at")
    .eq("municipality_id", context.municipalityId)
    .order("created_at", { ascending: false });
  if (error) return reply({ error: "Could not load documents." }, 500);
  return reply({ documents: data }, 200);
}

export async function POST(request: Request) {
  const context = await getAdminContext();
  if (!context) return reply({ error: "Unauthorized." }, 401);
  if (context.role === "viewer") return reply({ error: "Editor access is required." }, 403);

  const form = await request.formData();
  const title = String(form.get("title") || "").trim();
  const documentType = String(form.get("documentType") || "");
  const file = form.get("file");
  if (!(file instanceof File)) return reply({ error: "Select a document." }, 400);

  const validationError = validateDocumentInput({ title, documentType, filename: file.name, size: file.size });
  if (validationError) return reply({ error: validationError }, 400);

  const supabase = await createClient();
  const storagePath = `${context.municipalityId}/${crypto.randomUUID()}-${safeStorageFilename(file.name)}`;
  const { error: storageError } = await supabase.storage
    .from("municipal-documents")
    .upload(storagePath, file, { contentType: file.type || undefined, upsert: false });
  if (storageError) return reply({ error: "The document could not be stored." }, 500);

  const { data: municipality, error: municipalityError } = await supabase
    .from("municipalities")
    .select("vector_store_ids")
    .eq("id", context.municipalityId)
    .single();
  if (municipalityError) return reply({ error: "Municipality configuration could not be loaded." }, 500);
  const vectorStoreId = municipality.vector_store_ids?.[0];

  const { data: document, error: insertError } = await supabase
    .from("documents")
    .insert({
      municipality_id: context.municipalityId,
      title,
      document_type: documentType,
      status: vectorStoreId && process.env.OPENAI_API_KEY ? "processing" : "draft",
      storage_path: storagePath,
      uploaded_by: context.userId,
      metadata: { original_filename: file.name, size: file.size, content_type: file.type || null },
    })
    .select("id")
    .single();

  if (insertError) {
    await supabase.storage.from("municipal-documents").remove([storagePath]);
    return reply({ error: "Document metadata could not be saved." }, 500);
  }

  if (!vectorStoreId || !process.env.OPENAI_API_KEY) {
    return reply({ documentId: document.id, status: "draft", warning: "OpenAI indexing is not configured." }, 201);
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const vectorFile = await openai.vectorStores.files.uploadAndPoll(vectorStoreId, file);
    if (vectorFile.status !== "completed") {
      throw new Error(vectorFile.last_error?.message || `Indexing ended with status ${vectorFile.status}.`);
    }
    await supabase
      .from("documents")
      .update({ status: "published", openai_file_id: vectorFile.id, vector_store_id: vectorStoreId })
      .eq("id", document.id);
    return reply({ documentId: document.id, status: "published" }, 201);
  } catch (error) {
    console.error(`Document ${document.id} could not be indexed.`, error);
    await supabase.from("documents").update({ status: "error" }).eq("id", document.id);
    return reply({ error: "The file was stored, but search indexing failed.", documentId: document.id }, 502);
  }
}
