import { ClientGate } from "@/components/kh/client-gate";
import type { Metadata } from "next";
import { OnboardWizard } from "@/components/onboard/wizard";

export const metadata: Metadata = { title: "Onboard a token" };

export default function OnboardPage() {
  return (
    <ClientGate>
      <OnboardWizard />
    </ClientGate>
  );
}
