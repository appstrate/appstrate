import { Markdown } from "@/components/markdown";

interface ResultSummaryProps {
  text: string;
}

export function ResultSummary({ text }: ResultSummaryProps) {
  return <Markdown className="mb-3 leading-relaxed max-w-none text-sm">{text}</Markdown>;
}
