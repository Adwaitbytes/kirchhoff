import type { Metadata } from "next";
import { AttackLab } from "@/components/lab/attack-lab";

export const metadata: Metadata = { title: "Attack Lab" };

export default function LabPage() {
  return <AttackLab />;
}
