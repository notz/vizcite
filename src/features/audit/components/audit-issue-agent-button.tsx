import Link from "next/link";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  projectId: string;
  title: string;
  severity: string;
  explanation: string;
  howToFix: string;
  count: number;
  urls: string[];
  className?: string;
};

/** Kick-off message for the project agent: audit issue context + how to propose CMS edits (never applied without review). */
function auditIssueAgentPrompt(
  p: Omit<Props, "projectId" | "className">,
): string {
  const sev =
    p.severity === "critical"
      ? "error"
      : p.severity === "info"
        ? "notice"
        : "warning";
  const lines = [
    `Let's fix this site audit ${sev}: “${p.title}” (${p.count.toLocaleString()} affected).`,
    p.explanation ? `Why it matters: ${p.explanation}` : "",
    p.howToFix ? `How to fix: ${p.howToFix}` : "",
    p.urls.length
      ? `Example affected URLs:\n${p.urls
          .slice(0, 10)
          .map((u) => `- ${u}`)
          .join("\n")}`
      : "",
    "Look at the affected pages in our connected CMS (list_cms_items / get_cms_item) and propose concrete edits with propose_cms_change where the CMS can fix this (titles, meta descriptions, headings, image alt texts, JSON-LD). Explain each change briefly. If it can't be fixed through the CMS (e.g. redirects, server errors, speed), explain what needs to change instead. Don't apply anything: I'll review the proposals under Content → Site edits.",
  ];
  const text = lines.filter(Boolean).join("\n\n");
  return text.length > 3500 ? `${text.slice(0, 3499)}…` : text;
}

export function AuditIssueAgentButton({
  projectId,
  className,
  ...issue
}: Props) {
  return (
    <Button asChild variant="outline" size="sm" className={className}>
      <Link
        href={`/p/${projectId}/agent?prompt=${encodeURIComponent(auditIssueAgentPrompt(issue))}`}
      >
        <Bot className="size-3.5" /> Work with Agent
      </Link>
    </Button>
  );
}
