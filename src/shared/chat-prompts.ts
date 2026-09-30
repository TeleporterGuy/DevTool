import type { ChatPrompt, ChatPromptResponse } from './claude-chat'

/**
 * How a chat tab's prompt cards turn a choice into a {@link ChatPromptResponse}.
 * Shared by the desktop's PromptCards and the mobile bridge (`src/main/mobile`),
 * so an answer from the phone reaches Claude exactly as one from a window does.
 */

export interface PromptQuestion {
  question: string
  header?: string
  multiSelect: boolean
  options: { label: string; description?: string }[]
}

/** An AskUserQuestion prompt's questions, read defensively from its tool input. */
export function promptQuestions(input: Record<string, unknown>): PromptQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : []
  return raw.map((q) => {
    const question = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>
    const options = Array.isArray(question.options) ? question.options : []
    return {
      question: String(question.question ?? ''),
      header: typeof question.header === 'string' ? question.header : undefined,
      multiSelect: question.multiSelect === true,
      options: options.map((o) => {
        const option = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
        return { label: String(option.label ?? ''), description: typeof option.description === 'string' ? option.description : undefined }
      })
    }
  })
}

/** One question's answer: the picked labels (and any typed "Other"), joined. */
export function joinAnswerLabels(labels: string[]): string {
  return labels.join(', ')
}

/** Submit a question card: question text → answer, sent back in the tool's own input. */
export function questionAnswerResponse(prompt: ChatPrompt, answers: Record<string, string>): ChatPromptResponse {
  return { behavior: 'allow', updatedInput: { ...prompt.input, answers } }
}

/** "Skip" on a question card. */
export function dismissQuestionResponse(): ChatPromptResponse {
  return { behavior: 'deny', message: 'The user dismissed the question.' }
}

/** ExitPlanMode's plan text. */
export function planText(input: Record<string, unknown>): string {
  return typeof input.plan === 'string' ? input.plan : ''
}

/** "Approve" (or "Approve, auto-accept edits") on a plan card. */
export function planApprovalResponse(prompt: ChatPrompt, autoAcceptEdits = false): ChatPromptResponse {
  return { behavior: 'allow', always: autoAcceptEdits, updatedInput: prompt.input }
}

/** "Keep planning…" on a plan card, with optional feedback. */
export function planFeedbackResponse(feedback: string | undefined): ChatPromptResponse {
  return { behavior: 'deny', message: feedback?.trim() || 'Keep planning.' }
}

/** A permission prompt offers "Always allow" only when Claude suggested rules for it. */
export function canAlwaysAllow(prompt: ChatPrompt): boolean {
  return (prompt.suggestions?.length ?? 0) > 0
}
