// SPDX-License-Identifier: Apache-2.0

/**
 * The `ask_user` tool call (`pi-chat/ask-user.ts`), in two places, the way a
 * coding agent asks:
 * - in the transcript, the call's row: "waiting for your answer" while the turn
 *   holds it, then a quiet receipt of each question and its answer (read from
 *   the tool's own result, so a reloaded conversation shows it too);
 * - in place of the composer, the question panel: one tab per question header,
 *   options with their description, "Other" opening a free-text field, a recap
 *   tab before sending, Escape (or the close button) to skip.
 * Built from `@appstrate/ui` (tabs, radio group, checkbox, input, button). The
 * answer goes to the turn through `useAnswerQuestion` (the questions route).
 */

import * as React from "react";
import { makeAssistantToolUI, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { CheckIcon, MessageCircleQuestionIcon, XIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Input } from "@appstrate/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import type { AskUserAnswers, AskUserReply } from "../ask-user-reply.ts";
import { holdPendingQuestion, type PendingQuestion } from "./pending-questions.ts";
import { useAnswerQuestion, useChatHost } from "./runtime-context.ts";
import { asRecord, unwrapResult } from "./tool-result.ts";

type Question = PendingQuestion["questions"][number];
type AskUserProps = ToolCallMessagePartProps<{ questions?: Question[] }, unknown>;

/** Value of the "Other" choice; never a label (labels come from the model). */
const OTHER = "\u0000other";
const REVIEW_TAB = "\u0000review";

/**
 * The questions, once the model has written the whole argument. The adapter
 * strips the closing delimiters from `argsText` while the input streams
 * (`input-streaming`) and hands the full JSON once it is available, so text
 * that parses is the native "input complete" signal. A panel shown on
 * half-written questions could be sent before the tool even waits for it.
 */
function completeQuestions(props: AskUserProps): Question[] | null {
  try {
    JSON.parse(props.argsText);
  } catch {
    return null;
  }
  const questions = props.args?.questions;
  return Array.isArray(questions) && questions.length > 0 ? questions : null;
}

function readReply(result: unknown): AskUserReply | null {
  const reply = asRecord(unwrapResult(result));
  if (reply?.status === "cancelled") return { status: "cancelled" };
  if (reply?.status === "answered" && asRecord(reply.answers)) {
    return { status: "answered", answers: reply.answers as AskUserAnswers };
  }
  return null;
}

function answerText(answer: AskUserAnswers[string] | undefined): string[] {
  return [...(answer?.selected ?? []), ...(answer?.text ? [answer.text] : [])];
}

// ─── Transcript row ──────────────────────────────────────────────────────────

function Row({ children }: { children: React.ReactNode }) {
  const { t } = useChatHost();
  return (
    <div className="bg-card text-card-foreground my-3 w-full rounded-lg border text-sm">
      <div className="text-muted-foreground flex h-9 items-center gap-2 border-b px-3 text-xs font-medium">
        <MessageCircleQuestionIcon className="size-4" />
        {t("askUser.title")}
      </div>
      <div className="space-y-2 px-3 py-2">{children}</div>
    </div>
  );
}

/** While the turn waits: point at the panel, and hand it the call. */
function Waiting({ toolCallId, questions }: PendingQuestion) {
  const { t } = useChatHost();
  React.useEffect(() => holdPendingQuestion({ toolCallId, questions }), [toolCallId, questions]);
  return (
    <Row>
      <p className="text-muted-foreground">{t("askUser.waiting")}</p>
    </Row>
  );
}

function Receipt({ questions, reply }: { questions: Question[]; reply: AskUserReply | null }) {
  const { t } = useChatHost();
  return (
    <Row>
      {reply?.status === "answered" ? (
        <dl className="space-y-2">
          {questions.map((q) => {
            const shown = answerText(reply.answers[q.id]);
            return (
              <div key={q.id}>
                <dt className="font-medium">{q.question}</dt>
                <dd className="text-muted-foreground">
                  {shown.length ? shown.join(", ") : t("askUser.unanswered")}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-muted-foreground">
          {reply ? t("askUser.skipped") : t("askUser.unanswered")}
        </p>
      )}
    </Row>
  );
}

export const AskUserToolUI = makeAssistantToolUI<{ questions?: Question[] }, unknown>({
  toolName: "ask_user",
  render: (props: AskUserProps) => {
    const questions = completeQuestions(props);
    if (!questions) return null;
    // Held by a live turn: ask (in place of the composer). Anything else
    // (answered, skipped, or a turn that ended first) is history.
    if (props.result === undefined && props.status.type === "running") {
      return <Waiting toolCallId={props.toolCallId} questions={questions} />;
    }
    return <Receipt questions={questions} reply={readReply(props.result)} />;
  },
});

// ─── Panel (in place of the composer) ────────────────────────────────────────

/** One question's draft: the labels picked, and the "Other" text when chosen. */
interface Draft {
  selected: string[];
  other: boolean;
  text: string;
}

const EMPTY: Draft = { selected: [], other: false, text: "" };

function toAnswer(draft: Draft): AskUserAnswers[string] {
  const text = draft.other ? draft.text.trim() : "";
  return { selected: draft.selected, ...(text ? { text } : {}) };
}

function ChoiceRow({
  control,
  label,
  description,
}: {
  control: React.ReactNode;
  label: string;
  description?: string;
}) {
  return (
    <label className="hover:bg-muted/50 has-[[data-state=checked]]:bg-muted flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2">
      <span className="mt-0.5">{control}</span>
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">{label}</span>
        {description ? <span className="text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  );
}

function QuestionBody({
  question,
  draft,
  onChange,
  onPicked,
}: {
  question: Question;
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** A single-choice option was picked: the panel moves on. */
  onPicked: () => void;
}) {
  const { t } = useChatHost();
  const options = question.options ?? [];
  const textField = (onText: (text: string) => void, className?: string) => (
    <Input
      autoFocus
      value={draft.text}
      onChange={(e) => onText(e.target.value)}
      placeholder={t("askUser.ownAnswer")}
      className={className}
    />
  );

  if (options.length === 0) {
    return textField((text) => onChange({ selected: [], other: true, text }));
  }

  const otherField = draft.other
    ? textField((text) => onChange({ ...draft, text }), "ml-9 w-[calc(100%-2.25rem)]")
    : null;

  if (question.multiple) {
    const toggle = (label: string, on: boolean) =>
      onChange({
        ...draft,
        selected: on ? [...draft.selected, label] : draft.selected.filter((l) => l !== label),
      });
    return (
      <div className="space-y-1">
        {options.map((o) => (
          <ChoiceRow
            key={o.label}
            label={o.label}
            description={o.description}
            control={
              <Checkbox
                checked={draft.selected.includes(o.label)}
                onCheckedChange={(on) => toggle(o.label, on === true)}
              />
            }
          />
        ))}
        <ChoiceRow
          label={t("askUser.other")}
          control={
            <Checkbox
              checked={draft.other}
              onCheckedChange={(on) => onChange({ ...draft, other: on === true })}
            />
          }
        />
        {otherField}
      </div>
    );
  }

  return (
    <RadioGroup
      value={draft.other ? OTHER : (draft.selected[0] ?? "")}
      onValueChange={(picked) => {
        if (picked === OTHER) return onChange({ ...draft, selected: [], other: true });
        onChange({ ...draft, selected: [picked], other: false });
        onPicked();
      }}
      className="gap-1"
    >
      {options.map((o) => (
        <ChoiceRow
          key={o.label}
          label={o.label}
          description={o.description}
          control={<RadioGroupItem value={o.label} />}
        />
      ))}
      <ChoiceRow label={t("askUser.other")} control={<RadioGroupItem value={OTHER} />} />
      {otherField}
    </RadioGroup>
  );
}

export function AskUserPanel({ toolCallId, questions }: PendingQuestion) {
  const { t } = useChatHost();
  const answer = useAnswerQuestion();
  const single = questions.length === 1;
  const tabs = single ? [questions[0]!.id] : [...questions.map((q) => q.id), REVIEW_TAB];
  const [tab, setTab] = React.useState(tabs[0]!);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  const [sending, setSending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const draftOf = (id: string) => drafts[id] ?? EMPTY;
  const answered = (id: string) => answerText(toAnswer(draftOf(id))).length > 0;
  const next = () => setTab(tabs[Math.min(tabs.indexOf(tab) + 1, tabs.length - 1)]!);

  const send = (reply: AskUserReply) => {
    if (!answer || sending) return;
    setSending(true);
    setFailed(false);
    answer(toolCallId, reply).catch(() => {
      setFailed(true);
      setSending(false);
    });
  };
  const submit = () =>
    send({
      status: "answered",
      answers: Object.fromEntries(questions.map((q) => [q.id, toAnswer(draftOf(q.id))])),
    });
  const skip = () => send({ status: "cancelled" });

  return (
    <div
      className="bg-card w-full rounded-xl border shadow-sm"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          skip();
        }
      }}
    >
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-end gap-2 border-b px-4 pt-3">
          <TabsList variant="line" className="flex-wrap">
            {questions.map((q) => (
              <TabsTrigger key={q.id} value={q.id} className="gap-1.5">
                {q.header}
                {answered(q.id) ? <CheckIcon className="size-3.5" /> : null}
              </TabsTrigger>
            ))}
            {single ? null : <TabsTrigger value={REVIEW_TAB}>{t("askUser.review")}</TabsTrigger>}
          </TabsList>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={sending}
            onClick={skip}
            aria-label={t("askUser.skip")}
            className="text-muted-foreground mb-1 ml-auto size-8 shrink-0"
          >
            <XIcon />
          </Button>
        </div>

        {questions.map((q) => (
          <TabsContent key={q.id} value={q.id} className="mt-0 space-y-4 px-4 pt-4 pb-3 text-sm">
            <p className="font-medium">{q.question}</p>
            <QuestionBody
              question={q}
              draft={draftOf(q.id)}
              onChange={(draft) => setDrafts((all) => ({ ...all, [q.id]: draft }))}
              onPicked={single ? () => undefined : next}
            />
            <div className="flex justify-end">
              {single ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={sending || !answered(q.id)}
                  onClick={submit}
                >
                  {t("askUser.submit")}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant={answered(q.id) ? "default" : "outline"}
                  onClick={next}
                >
                  {t("askUser.next")}
                </Button>
              )}
            </div>
          </TabsContent>
        ))}

        {single ? null : (
          <TabsContent value={REVIEW_TAB} className="mt-0 space-y-4 px-4 pt-4 pb-3 text-sm">
            <div className="space-y-1">
              {questions.map((q) => {
                const shown = answerText(toAnswer(draftOf(q.id)));
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => setTab(q.id)}
                    className="hover:bg-muted/50 block w-full rounded-lg px-2 py-1 text-left"
                  >
                    <span className="block font-medium">{q.question}</span>
                    <span className="text-muted-foreground block">
                      {shown.length ? shown.join(", ") : t("askUser.unanswered")}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex justify-end">
              <Button type="button" size="sm" disabled={sending} onClick={submit}>
                {t("askUser.submit")}
              </Button>
            </div>
          </TabsContent>
        )}
      </Tabs>
      <div className="text-muted-foreground flex items-center justify-between border-t px-4 py-1.5 text-xs">
        <span>{t("askUser.escHint")}</span>
        {failed ? <span className="text-destructive">{t("askUser.failed")}</span> : null}
      </div>
    </div>
  );
}
