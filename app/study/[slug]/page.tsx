import StudyClient from "./study-client";

export default async function StudyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <StudyClient slug={slug} />;
}
