// Questions with a saved answer in data/fastapi-template/answers, strongest first and weakest last.
// The wording is not in those files, and eval/questions.json words its delete question differently, so it lives here.
// web/scripts/filegraph.check.ts fails if this list and those files stop matching.

export interface Example {
  label: string
  question: string
}

export interface AskNote {
  kicker: string
  text: string
}

export const EXAMPLES_REPO = 'fastapi/full-stack-fastapi-template'
export const STRIP_COUNT = 5

export const EXAMPLES: Example[] = [
  { label: 'Login', question: 'How does login work?' },
  { label: 'Sign-up', question: 'How does a new user sign up?' },
  { label: 'Password reset', question: 'What happens when a user submits a new password with a reset token?' },
  { label: 'Recovery email', question: 'How does a password recovery request end up sending an email?' },
  { label: 'Current user', question: 'How does the API work out who the current user is from a request?' },
  { label: 'Admin adds user', question: 'When an admin creates a user, how does the new account email get sent?' },
  { label: 'Superuser check', question: 'How is an endpoint restricted to superusers?' },
  { label: 'First superuser', question: 'How is the first superuser created when the app is set up?' },
  { label: 'Delete cascade', question: 'How are items deleted when a user account is deleted?' },
  { label: 'Create an item', question: 'What happens when a signed-in user creates an item?' },
]

// The same rule as answer_path in backend/trace/api/app.py.
export function answerSlug(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

const RECORDED = new Set(EXAMPLES.map((example) => answerSlug(example.question)))

export function isRecorded(question: string): boolean {
  return RECORDED.has(answerSlug(question))
}

// What the strip says instead of offering questions, or null when it should offer them.
export function askNote(busy: boolean, asked: string, typed: string): AskNote | null {
  if (busy) {
    if (isRecorded(asked)) return { kicker: 'Recorded', text: 'Replaying a saved run, not a live one.' }
    return { kicker: 'Live', text: 'The agent is running. This takes about a minute.' }
  }
  if (!typed.trim()) return null
  if (isRecorded(typed)) return { kicker: 'Recorded', text: 'This one replays a saved run.' }
  return { kicker: 'Live', text: 'Not a recorded question. The agent runs live, about a minute.' }
}
