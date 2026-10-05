import { ClientGate } from "@/components/kh/client-gate";
import type { Metadata } from "next";
import { StatusPage } from "@/components/status-page/status-page";

interface Props {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const symbol = decodeURIComponent(token);
  return { title: `${symbol} status`, description: `Live conservation status of ${symbol} across every chain, verified onchain by KIRCHHOFF.` };
}

export default async function PublicStatusPage({ params }: Props) {
  const { token } = await params;
  return (
    <ClientGate>
      <StatusPage token={decodeURIComponent(token)} />
    </ClientGate>
  );
}
