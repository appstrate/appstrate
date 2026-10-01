// SPDX-License-Identifier: Apache-2.0

/**
 * The `ask_user` tool call (`pi-chat/ask-user.ts`): while the turn waits, the
 * shadcn `Questionnaire` (one question at a time, a free-text answer always
 * possible); once answered or skipped, a quiet receipt of each question and its
 * answer. The answer goes to the turn through `useAnswerQuestion` (a POST to the
 * questions route); the receipt reads the tool's own result, so it is also what
 * a reloaded conversation shows.
 */

import * as React from "react";
import { makeAssistantToolUI, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { MessageCircleQuestionIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@appstrate/ui/components/questionnaire";
import type { AskUserAnswers, AskUserReply } from "../ask-user-reply.ts";
import { useAnswerQuestion, useChatHost } from "./runtime-context.ts";
import { asRecord, unwrapResult } from "./tool-result.ts";

interface Question {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiple?: boolean;
}

type AskUserProps = ToolCallMessagePartProps<{ questions?: Question[] }, unknown>;

/**
 * The questions, once the model has written the whole argument. The adapter
 * strips the closing delimiters from `argsText` while the input streams
 * (`input-streaming`) and hands the full JSON once it is available, so text
 * that parses is the native "input complete" signal. A form shown on
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

/** Choices are option labels; anything else the field carries is the typed answer. */
function answersFrom(form: HTMLFormElement, questions: Question[]): AskUserAnswers {
  const data = new FormData(form);
  return Object.fromEntries(
    questions.map((q) => {
      const labels = new Set((q.options ?? []).map((o) => o.label));
      const values = data
        .getAll(q.id)
        .map(String)
        .filter((v) => v.trim());
      const text = values.filter((v) => !labels.has(v)).join("\n");
      return [q.id, { selected: values.filter((v) => labels.has(v)), ...(text ? { text } : {}) }];
    }),
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useChatHost();
  return (
    <div className="bg-card text-card-foreground my-3 w-full space-y-3 rounded-lg border p-3 text-sm">
      <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
        <MessageCircleQuestionIcon className="size-4" />
        {t("askUser.title")}
      </div>
      {children}
    </div>
  );
}

function Receipt({ questions, reply }: { questions: Question[]; reply: AskUserReply | null }) {
  const { t } = useChatHost();
  return (
    <Shell>
      {reply?.status === "answered" ? (
        <dl className="space-y-2">
          {questions.map((q) => {
            const answer = reply.answers[q.id];
            const shown = [...(answer?.selected ?? []), ...(answer?.text ? [answer.text] : [])];
            return (
              <div key={q.id}>
                <dt className="text-muted-foreground text-xs">{q.question}</dt>
                <dd>{shown.length ? shown.join(", ") : t("askUser.unanswered")}</dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-muted-foreground">
          {reply ? t("askUser.skipped") : t("askUser.unanswered")}
        </p>
      )}
    </Shell>
  );
}

function Form({ questions, toolCallId }: { questions: Question[]; toolCallId: string }) {
  const { t } = useChatHost();
  const answer = useAnswerQuestion();
  const [sending, setSending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [current, setCurrent] = React.useState(questions[0]!.id);

  const send = (reply: AskUserReply) => {
    if (!answer) return;
    setSending(true);
    setFailed(false);
    answer(toolCallId, reply).catch(() => {
      setFailed(true);
      setSending(false);
    });
  };

  return (
    <Shell>
      <Questionnaire
        onItemChange={setCurrent}
        onSubmit={(e) => {
          e.preventDefault();
          send({ status: "answered", answers: answersFrom(e.currentTarget, questions) });
        }}
      >
        {questions.length > 1 ? (
          <p className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
            {t("askUser.progress", {
              current: questions.findIndex((q) => q.id === current) + 1,
              total: questions.length,
            })}
          </p>
        ) : null}
        {questions.map((q) => (
          <QuestionnaireItem key={q.id} name={q.id} multiple={q.multiple} required>
            <QuestionnaireTitle className="text-sm">
              <span className="text-muted-foreground mb-1 block text-xs font-medium uppercase">
                {q.header}
              </span>
              {q.question}
            </QuestionnaireTitle>
            <QuestionnaireChoices>
              {(q.options ?? []).map((o) => (
                <QuestionnaireChoice key={o.label} value={o.label}>
                  {o.label}
                  {o.description ? (
                    <QuestionnaireChoiceDescription>{o.description}</QuestionnaireChoiceDescription>
                  ) : null}
                </QuestionnaireChoice>
              ))}
              <QuestionnaireInput placeholder={t("askUser.ownAnswer")} />
            </QuestionnaireChoices>
          </QuestionnaireItem>
        ))}
        {failed ? <p className="text-destructive text-xs">{t("askUser.failed")}</p> : null}
        <QuestionnaireActions>
          <QuestionnairePrevious size="sm" disabled={sending}>
            {t("askUser.previous")}
          </QuestionnairePrevious>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={sending}
            onClick={() => send({ status: "cancelled" })}
            className="col-start-2 row-start-1 justify-self-end"
          >
            {t("askUser.skip")}
          </Button>
          <QuestionnaireNext size="sm" disabled={sending}>
            {t("askUser.next")}
          </QuestionnaireNext>
          <QuestionnaireSubmit size="sm" disabled={sending}>
            {t("askUser.submit")}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </Shell>
  );
}

export const AskUserToolUI = makeAssistantToolUI<{ questions?: Question[] }, unknown>({
  toolName: "ask_user",
  render: (props: AskUserProps) => {
    const questions = completeQuestions(props);
    if (!questions) return null;
    // Held by a live turn: ask. Anything else (answered, skipped, or a turn
    // that ended first) is history: show what came of it.
    if (props.result === undefined && props.status.type === "running") {
      return <Form questions={questions} toolCallId={props.toolCallId} />;
    }
    return <Receipt questions={questions} reply={readReply(props.result)} />;
  },
});
