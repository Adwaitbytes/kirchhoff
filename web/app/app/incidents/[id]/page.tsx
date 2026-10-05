import { ClientGate } from "@/components/kh/client-gate";
import type { Metadata } from "next";
import { IncidentRoom } from "@/components/incident/incident-room";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Incident ${decodeURIComponent(id).slice(0, 10)}` };
}

export default async function IncidentPage({ params }: Props) {
  const { id } = await params;
  return (
    <ClientGate>
      <IncidentRoom id={decodeURIComponent(id)} />
    </ClientGate>
  );
}
