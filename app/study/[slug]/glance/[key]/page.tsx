import GlanceClient from "./glance-client";

export default async function GlancePage({ params }: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await params;
  return <GlanceClient slug={slug} shortKey={key} />;
}
