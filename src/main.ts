import './style.css'
import englishWordsRaw from './wordlists/english-5.txt?raw'
import dutchWordsRaw from './wordlists/dutch-5.txt?raw'

const MAX_GUESSES = 6
const WORD_LENGTH = 5
const ANSWER = 'PAARD'
const STORAGE_KEY = 'paardle-state-v1'
const KEYBOARD_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ENTERZXCVBNMBACKSPACE']
const REVEAL_STEP_MS = 300
const INVALID_WORD_MESSAGE = 'Only real 5-letter Dutch or English words.'

type LetterState = 'correct' | 'present' | 'absent'

interface ScoreEntry {
  date: string
  won: boolean
  guesses: number | null
}

interface GameState {
  dayKey: string
  guesses: string[]
  won: boolean
  gameOver: boolean
  scoreRecorded: boolean
  scores: ScoreEntry[]
}

interface ScoreStatistics {
  played: number
  wins: number
  losses: number
  winRate: number
  averageWinGuesses: string
  bestWinGuesses: number | null
  distribution: number[]
}

const appElement = document.querySelector<HTMLDivElement>('#app')

if (!appElement) {
  throw new Error('App root not found')
}

const app = appElement

let state = loadState()
let draft = ''
let statusMessage = ''
let revealingRowIndex: number | null = null
let revealTimeout: ReturnType<typeof setTimeout> | null = null
let revealToken = 0
let isStatsOpen = false
let statsSnapshot: ScoreStatistics | null = null
let shouldRestoreStatsButtonFocus = false

let validWords: Set<string> | null = null

function getValidWords(): Set<string> {
  if (validWords) return validWords
  validWords = new Set(
    [...englishWordsRaw.split('\n'), ...dutchWordsRaw.split('\n')]
      .map((word) => word.trim().toUpperCase())
      .filter((word) => /^[A-Z]{5}$/.test(word)),
  )
  validWords.add(ANSWER)
  return validWords
}

function getAmsterdamDayKey(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function getAmsterdamTimeParts(date = new Date()): { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const asNumber = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')

  return { hour: asNumber('hour'), minute: asNumber('minute'), second: asNumber('second') }
}

function formatTimeUntilReset(): string {
  const { hour, minute, second } = getAmsterdamTimeParts()
  const totalSeconds = 24 * 60 * 60 - (hour * 60 * 60 + minute * 60 + second)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function loadState(): GameState {
  const today = getAmsterdamDayKey()
  const initial: GameState = {
    dayKey: today,
    guesses: [],
    won: false,
    gameOver: false,
    scoreRecorded: false,
    scores: [],
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return initial
    const parsed = JSON.parse(raw) as Partial<GameState>
    const nextState: GameState = {
      dayKey: typeof parsed.dayKey === 'string' ? parsed.dayKey : today,
      guesses: Array.isArray(parsed.guesses)
        ? parsed.guesses.filter((guess): guess is string => typeof guess === 'string').slice(0, MAX_GUESSES)
        : [],
      won: Boolean(parsed.won),
      gameOver: Boolean(parsed.gameOver),
      scoreRecorded: Boolean(parsed.scoreRecorded),
      scores: Array.isArray(parsed.scores)
        ? parsed.scores.filter(
            (score): score is ScoreEntry =>
              typeof score?.date === 'string' &&
              typeof score?.won === 'boolean' &&
              (typeof score?.guesses === 'number' || score?.guesses === null),
          )
        : [],
    }

    if (nextState.dayKey !== today) {
      nextState.dayKey = today
      nextState.guesses = []
      nextState.won = false
      nextState.gameOver = false
      nextState.scoreRecorded = false
    }

    return nextState
  } catch {
    return initial
  }
}

function saveState() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // no-op when storage is unavailable
  }
}

function evaluateGuess(guess: string): LetterState[] {
  const answerLetters = ANSWER.split('')
  const result: LetterState[] = Array<LetterState>(WORD_LENGTH).fill('absent')

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    if (guess[index] === answerLetters[index]) {
      result[index] = 'correct'
      answerLetters[index] = ''
    }
  }

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    if (result[index] !== 'absent') continue
    const answerIndex = answerLetters.indexOf(guess[index])
    if (answerIndex >= 0) {
      result[index] = 'present'
      answerLetters[answerIndex] = ''
    }
  }

  return result
}

function setKeyboardStatus(current: Record<string, LetterState>, letter: string, next: LetterState) {
  const priority: Record<LetterState, number> = { absent: 0, present: 1, correct: 2 }
  if (!current[letter] || priority[next] > priority[current[letter]]) {
    current[letter] = next
  }
}

function getKeyboardStatuses(): Record<string, LetterState> {
  const statuses: Record<string, LetterState> = {}
  for (const [rowIndex, guess] of state.guesses.entries()) {
    if (rowIndex === revealingRowIndex) continue
    const evaluation = evaluateGuess(guess)
    for (let i = 0; i < guess.length; i += 1) {
      setKeyboardStatus(statuses, guess[i], evaluation[i])
    }
  }
  return statuses
}

function recordDailyScore() {
  if (state.scoreRecorded) return
  if (state.scores.some((score) => score.date === state.dayKey)) {
    state.scoreRecorded = true
    return
  }
  state.scores.push({
    date: state.dayKey,
    won: state.won,
    guesses: state.won ? state.guesses.length : null,
  })
  state.scoreRecorded = true
}

function getScoreStatistics(scores: ScoreEntry[]): ScoreStatistics {
  const played = scores.length
  const wins = scores.filter((score) => score.won).length
  const losses = played - wins
  const winRate = played > 0 ? Math.round((wins / played) * 100) : 0
  const winningGuesses = scores
    .filter((score): score is ScoreEntry & { guesses: number } => score.won && typeof score.guesses === 'number')
    .map((score) => score.guesses)
  const averageWinGuesses = winningGuesses.length
    ? (winningGuesses.reduce((sum, guesses) => sum + guesses, 0) / winningGuesses.length).toFixed(2)
    : '—'
  const bestWinGuesses = winningGuesses.length ? Math.min(...winningGuesses) : null
  const distribution = Array.from({ length: MAX_GUESSES }, (_, index) =>
    scores.filter((score) => score.won && score.guesses === index + 1).length,
  )

  return { played, wins, losses, winRate, averageWinGuesses, bestWinGuesses, distribution }
}

function endGame(won: boolean) {
  state.won = won
  state.gameOver = true
  recordDailyScore()
  saveState()
  render()
}

function shouldDisableInput(): boolean {
  return isStatsOpen || state.gameOver || revealingRowIndex !== null
}

function submitGuess() {
  if (draft.length !== WORD_LENGTH || shouldDisableInput() || state.guesses.length >= MAX_GUESSES) {
    return
  }

  const guess = draft
  if (!getValidWords().has(guess)) {
    statusMessage = INVALID_WORD_MESSAGE
    return
  }

  statusMessage = ''
  draft = ''
  state.guesses.push(guess)
  revealingRowIndex = state.guesses.length - 1
  saveState()

  if (revealTimeout) clearTimeout(revealTimeout)
  const token = ++revealToken
  revealTimeout = setTimeout(() => {
    if (token !== revealToken) return
    revealingRowIndex = null
    revealTimeout = null

    if (guess === ANSWER) {
      endGame(true)
      return
    }

    if (state.guesses.length >= MAX_GUESSES) {
      endGame(false)
      return
    }

    saveState()
    render()
  }, REVEAL_STEP_MS * WORD_LENGTH)
}

function handleKey(input: string) {
  if (shouldDisableInput()) return

  if (input === 'ENTER') {
    submitGuess()
  } else if (input === 'BACKSPACE') {
    statusMessage = ''
    draft = draft.slice(0, -1)
  } else if (/^[A-Z]$/.test(input) && draft.length < WORD_LENGTH) {
    statusMessage = ''
    draft += input
  }

  render()
}

function resetForNewDay(nextDay: string) {
  revealingRowIndex = null
  revealToken += 1
  if (revealTimeout) {
    clearTimeout(revealTimeout)
    revealTimeout = null
  }

  statusMessage = ''
  state.dayKey = nextDay
  state.guesses = []
  state.won = false
  state.gameOver = false
  state.scoreRecorded = false
  draft = ''
  saveState()
  render()
}

function render() {
  const shouldRestoreNativeInputFocus =
    document.activeElement instanceof HTMLInputElement && document.activeElement.dataset.nativeInput === 'true'
  const stats = isStatsOpen ? (statsSnapshot ?? getScoreStatistics(state.scores)) : null
  const maxDistributionCount = stats ? Math.max(1, ...stats.distribution) : 1
  const keyboardStatuses = getKeyboardStatuses()
  const scoreItems = [...state.scores]
    .reverse()
    .map(
      (score) =>
        `<li><span>${score.date}</span><span>${score.won ? `${score.guesses}/6` : 'X/6'}</span></li>`,
    )
    .join('')

  app.innerHTML = `
    <header class="top-bar">
      <h1>PAARDLE</h1>
      <button type="button" class="stats-button" data-action="open-stats" aria-haspopup="dialog" aria-expanded="${isStatsOpen ? 'true' : 'false'}">Statistics</button>
    </header>
    <main class="game-shell">
      <section class="board" aria-label="Word grid">
        ${Array.from({ length: MAX_GUESSES }, (_, row) => {
          const submittedGuess = state.guesses[row]
          const rowGuess =
            submittedGuess ?? (row === state.guesses.length && !state.gameOver ? draft.padEnd(WORD_LENGTH, ' ') : ' '.repeat(WORD_LENGTH))
          const states = submittedGuess ? evaluateGuess(submittedGuess) : Array<LetterState>(WORD_LENGTH).fill('absent')
          return `
            <div class="row">
              ${Array.from({ length: WORD_LENGTH }, (_, col) => {
                const letter = rowGuess[col] === ' ' ? '&nbsp;' : rowGuess[col]
                const isRevealing = Boolean(submittedGuess) && row === revealingRowIndex
                const tileClass = submittedGuess
                  ? `tile state-${states[col]}${isRevealing ? ' reveal' : ''}`
                  : `tile${rowGuess[col] === ' ' ? '' : ' filled'}`
                const tileStyle = isRevealing ? ` style="--reveal-delay:${col * REVEAL_STEP_MS}ms"` : ''
                return `<div class="${tileClass}"${tileStyle}>${letter}</div>`
              }).join('')}
            </div>
          `
        }).join('')}
      </section>

      <p class="status">
        ${
          state.gameOver
            ? state.won
              ? `Won in ${state.guesses.length}/6. New round in ${formatTimeUntilReset()} (Amsterdam).`
              : `Not guessed. The word was ${ANSWER}. New round in ${formatTimeUntilReset()} (Amsterdam).`
            : statusMessage || 'Guess the word in 6 tries.'
        }
      </p>

      <section class="native-input-shell">
        <label class="native-input-label" for="native-input">Use your phone keyboard</label>
        <input
          id="native-input"
          class="native-input"
          data-native-input="true"
          type="text"
          inputmode="text"
          autocomplete="off"
          autocapitalize="characters"
          autocorrect="off"
          spellcheck="false"
          enterkeyhint="done"
          maxlength="${WORD_LENGTH}"
          aria-label="Type your guess"
          value="${draft}"
        />
      </section>

      <section class="keyboard" aria-label="Keyboard">
        ${KEYBOARD_ROWS.map((row) => {
          const keys =
            row === 'ENTERZXCVBNMBACKSPACE'
              ? ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'BACKSPACE']
              : row.split('')
          return `<div class="key-row">${keys
            .map((key) => {
              const label = key === 'BACKSPACE' ? '⌫' : key
              const stateClass = keyboardStatuses[key] ? ` state-${keyboardStatuses[key]}` : ''
              const bigClass = key === 'ENTER' || key === 'BACKSPACE' ? ' key-big' : ''
              return `<button type="button" class="key${stateClass}${bigClass}" data-key="${key}" aria-label="${key}">${label}</button>`
            })
            .join('')}</div>`
        }).join('')}
      </section>
    </main>
    ${
      stats
        ? `
      <button type="button" class="stats-overlay" data-action="close-stats" aria-label="Close statistics"></button>
      <section class="stats-modal" role="dialog" aria-modal="true" aria-label="Statistics">
        <div class="stats-modal-header">
          <h2>Statistics</h2>
          <button type="button" class="stats-close" data-action="close-stats" aria-label="Close">✕</button>
        </div>
        <div class="stats-grid">
          <article><strong>${stats.played}</strong><span>Played</span></article>
          <article><strong>${stats.winRate}%</strong><span>Win rate</span></article>
          <article><strong>${stats.wins}</strong><span>Won</span></article>
          <article><strong>${stats.losses}</strong><span>Lost</span></article>
          <article><strong>${stats.averageWinGuesses}</strong><span>Avg. guesses (wins)</span></article>
          <article><strong>${stats.bestWinGuesses ?? '—'}</strong><span>Best score</span></article>
        </div>
        <h3>Distribution</h3>
        <ul class="distribution">
          ${stats.distribution
            .map(
              (count, index) => `
            <li>
              <span class="distribution-label">${index + 1}</span>
              <span class="distribution-track" role="img" aria-label="${index + 1} pogingen: ${count} keer"><span class="distribution-fill" style="width:${Math.round((count / maxDistributionCount) * 100)}%"></span></span>
              <span class="distribution-count">${count}</span>
            </li>`,
            )
            .join('')}
        </ul>
        <h3>Previous scores</h3>
        ${state.scores.length > 0 ? `<ul class="history-list">${scoreItems}</ul>` : '<p class="history-empty">No completed games yet.</p>'}
      </section>
    `
        : ''
    }
  `

  app.querySelectorAll<HTMLButtonElement>('button[data-key]').forEach((button) => {
    button.addEventListener('click', () => handleKey(button.dataset.key ?? ''))
    button.disabled = shouldDisableInput()
  })

  const nativeInput = app.querySelector<HTMLInputElement>('input[data-native-input="true"]')
  if (nativeInput) {
    nativeInput.disabled = shouldDisableInput()
    nativeInput.addEventListener('input', () => {
      if (shouldDisableInput()) return
      const nextDraft = nativeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, WORD_LENGTH)
      if (nextDraft === draft) {
        nativeInput.value = draft
        return
      }
      statusMessage = ''
      draft = nextDraft
      render()
    })
    nativeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        handleKey('ENTER')
      }
    })
  }

  app.querySelector('.board')?.addEventListener('click', () => {
    if (shouldDisableInput()) return
    app.querySelector<HTMLInputElement>('input[data-native-input="true"]')?.focus()
  })

  app.querySelectorAll<HTMLButtonElement>('button[data-action="open-stats"]').forEach((button) => {
    button.addEventListener('click', () => {
      statsSnapshot = getScoreStatistics(state.scores)
      isStatsOpen = true
      render()
    })
  })

  app.querySelectorAll<HTMLElement>('[data-action="close-stats"]').forEach((element) => {
    element.addEventListener('click', () => {
      statsSnapshot = null
      isStatsOpen = false
      shouldRestoreStatsButtonFocus = true
      render()
    })
  })

  if (isStatsOpen) {
    app.querySelector<HTMLButtonElement>('.stats-close')?.focus()
  } else if (shouldRestoreStatsButtonFocus) {
    app.querySelector<HTMLButtonElement>('button[data-action="open-stats"]')?.focus()
    shouldRestoreStatsButtonFocus = false
  } else if (shouldRestoreNativeInputFocus && !shouldDisableInput()) {
    nativeInput?.focus()
  }
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isStatsOpen) {
    event.preventDefault()
    statsSnapshot = null
    isStatsOpen = false
    shouldRestoreStatsButtonFocus = true
    render()
    return
  }

  const key = event.key.toUpperCase()
  if (key === 'ENTER' || key === 'BACKSPACE' || /^[A-Z]$/.test(key)) {
    event.preventDefault()
    handleKey(key)
  }
})

setInterval(() => {
  const currentDay = getAmsterdamDayKey()
  if (currentDay !== state.dayKey) {
    resetForNewDay(currentDay)
    return
  }
  if (state.gameOver) {
    render()
  }
}, 30_000)

if (state.gameOver) {
  recordDailyScore()
  saveState()
}

render()
