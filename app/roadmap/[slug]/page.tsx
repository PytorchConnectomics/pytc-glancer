import RoadmapClient from "./roadmap-client";

export default async function RoadmapPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <RoadmapClient slug={slug} />;
}
