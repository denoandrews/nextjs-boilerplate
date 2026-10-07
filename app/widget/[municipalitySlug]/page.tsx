import { Chat } from "@/components/chat";

export default async function WidgetPage({
  params,
}: {
  params: Promise<{ municipalitySlug: string }>;
}) {
  const { municipalitySlug } = await params;
  return (
    <main className="widget-shell">
      <Chat municipalitySlug={municipalitySlug} compact />
    </main>
  );
}
