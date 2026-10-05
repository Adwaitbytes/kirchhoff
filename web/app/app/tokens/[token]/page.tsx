import type { Metadata } from "next";
import { MissionControl } from "@/components/mission/mission-control";

interface Props {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  return { title: `${decodeURIComponent(token)} Mission Control` };
}

export default async function MissionControlPage({ params }: Props) {
  const { token } = await params;
  return <MissionControl token={decodeURIComponent(token)} />;
}
