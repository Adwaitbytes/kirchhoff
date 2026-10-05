import { ClientGate } from "@/components/kh/client-gate";
import type { Metadata } from "next";
import { Integrations } from "@/components/integrate/integrations";

export const metadata: Metadata = { title: "Integrations" };

export default function IntegratePage() {
  return (
    <ClientGate>
      <Integrations />
    </ClientGate>
  );
}
