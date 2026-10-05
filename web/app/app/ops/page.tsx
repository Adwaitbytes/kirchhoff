import { ClientGate } from "@/components/kh/client-gate";
import type { Metadata } from "next";
import { VerifierOps } from "@/components/ops/verifier-ops";

export const metadata: Metadata = { title: "Verifier Ops" };

export default function OpsPage() {
  return (
    <ClientGate>
      <VerifierOps />
    </ClientGate>
  );
}
