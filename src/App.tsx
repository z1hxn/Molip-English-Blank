import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import './App.css'

type Screen = 'home' | 'create' | 'script' | 'study' | 'quiz'

type QuizItem = {
  number: string
  meaning: string
  english: string
}

type TextUnit = {
  kind: 'text'
  token: string
}

type BlankUnit = {
  kind: 'blank'
  blankId: string
  prefix: string
  suffix: string
  answer: string
  width: number
}

type SentenceUnit = TextUnit | BlankUnit

type QuizQuestion = {
  number: string
  meaning: string
  sourceIndex: number
  units: SentenceUnit[]
}

type QuestionGrade = {
  total: number
  correct: number
  checkedById: Record<string, boolean>
}

type StudyAnswerHistory = {
  queue: number[]
  unknownQueue: number[]
  index: number
  score: number
  answeredCount: number
  done: boolean
  revealed: boolean
}

type ScriptRecord = {
  id: string
  title: string
  rawText: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
}

type QuizSessionRecord = {
  id: string
  scriptId: string
  createdAt: string
  totalQuestions: number
  totalBlanks: number
  correctBlanks: number
  wrongSentences: number
  blankRatio: number
}

type SentenceStat = {
  sentenceKey: string
  number: string
  meaning: string
  english: string
  studyRevealCount: number
  quizAttempts: number
  wrongCount: number
  wrongBlankCount: number
  lastStudiedAt?: string
  lastQuizAt?: string
}

type LearningStore = {
  scripts: ScriptRecord[]
  quizSessions: QuizSessionRecord[]
  sentenceStatsByScript: Record<string, Record<string, SentenceStat>>
}

type ScriptRow = {
  id: string
  owner_username: string
  title: string
  raw_text: string
  created_at: string
  updated_at: string
  last_opened_at: string
}

type QuizSessionRow = {
  id: string
  owner_username: string
  script_id: string
  created_at: string
  total_questions: number
  total_blanks: number
  correct_blanks: number
  wrong_sentences: number
  blank_ratio: number
}

type SentenceStatRow = {
  owner_username: string
  script_id: string
  sentence_key: string
  number: string
  meaning: string
  english: string
  study_reveal_count: number
  quiz_attempts: number
  wrong_count: number
  wrong_blank_count: number
  last_studied_at: string | null
  last_quiz_at: string | null
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'i',
  'in',
  'is',
  'it',
  'its',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'that',
  'the',
  'their',
  'them',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'with',
  'you',
  'your',
  'will',
  'every',
  'day',
])

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const nowIso = () => new Date().toISOString()
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))

const toFriendlyDbError = (message: string) => {
  const lowered = message.toLowerCase()
  if (lowered.includes('invalid schema')) {
    return 'Supabase API 설정에서 Exposed schemas에 `molip_english_blank`를 추가해 주세요.'
  }
  if (lowered.includes('relation') && lowered.includes('does not exist')) {
    return '`supabase.sql`을 다시 실행해 테이블을 생성해 주세요.'
  }
  if (
    lowered.includes('permission denied') ||
    lowered.includes('violates row-level security policy')
  ) {
    return '권한 설정 문제입니다. 스키마/테이블 grant 또는 RLS 설정을 확인해 주세요.'
  }
  return message
}

const normalizeCoreLower = (value: string) =>
  value
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '')
    .trim()

const normalizeCoreCaseSensitive = (value: string) =>
  value.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '').trim()

const parseTokenParts = (token: string) => {
  const match = token.match(/^([^A-Za-z0-9']*)([A-Za-z0-9']+)([^A-Za-z0-9']*)$/)
  if (!match) {
    return { prefix: '', core: '', suffix: '' }
  }
  const [, prefix, core, suffix] = match
  return { prefix, core, suffix }
}

const parseItems = (rawText: string): QuizItem[] => {
  const lines = rawText
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[^\]]*]$/.test(line))

  if (!lines.length) return []

  const items: QuizItem[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const numberMatch = lines[i].match(/^(\d+)\.\s*(.+)$/)
    if (!numberMatch) continue

    const [, number, meaning] = numberMatch
    const nextLine = lines[i + 1] ?? ''
    if (!nextLine || /^\d+\.\s+/.test(nextLine) || /^\[[^\]]*]$/.test(nextLine)) {
      continue
    }

    items.push({
      number,
      meaning: meaning.trim(),
      english: nextLine.trim(),
    })
    i += 1
  }

  return items
}

const pickRandomIndices = (pool: number[], count: number) => {
  const shuffled = [...pool]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, count)
}

const makeQuestion = (item: QuizItem, sourceIndex: number, blankRatio: number): QuizQuestion => {
  const tokens = item.english.split(/\s+/).filter(Boolean)
  const candidates = tokens
    .map((token, index) => ({ index, core: normalizeCoreLower(token) }))
    .filter(({ core }) => core.length > 2 && !STOP_WORDS.has(core))
    .map(({ index }) => index)

  const fallback = tokens
    .map((token, index) => ({ index, core: normalizeCoreLower(token) }))
    .filter(({ core }) => core.length > 0)
    .map(({ index }) => index)

  const blankCount = clamp(Math.round(tokens.length * (blankRatio / 100)), 1, tokens.length)
  const selected = new Set<number>()
  pickRandomIndices(candidates, blankCount).forEach((index) => selected.add(index))

  if (selected.size < blankCount) {
    const needed = blankCount - selected.size
    const rest = fallback.filter((index) => !selected.has(index))
    pickRandomIndices(rest, needed).forEach((index) => selected.add(index))
  }

  const units: SentenceUnit[] = tokens.map((token, index) => {
    if (!selected.has(index)) {
      return { kind: 'text', token }
    }

    const { prefix, core, suffix } = parseTokenParts(token)
    if (!core) {
      return { kind: 'text', token }
    }

    return {
      kind: 'blank',
      blankId: `${item.number}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      prefix,
      suffix,
      answer: core,
      width: Math.max(88, Math.min(220, core.length * 16)),
    }
  })

  return {
    number: item.number,
    meaning: item.meaning,
    sourceIndex,
    units,
  }
}

const makeExam = (items: QuizItem[], blankRatio: number) =>
  items.map((item, index) => makeQuestion(item, index, blankRatio))

const collectBlankUnits = (questions: QuizQuestion[]) =>
  questions.flatMap((question) =>
    question.units
      .filter((unit): unit is BlankUnit => unit.kind === 'blank')
      .map((unit) => ({ questionNumber: question.number, ...unit })),
  )

const createEmptyAnswers = (questions: QuizQuestion[]) => {
  const next: Record<string, string> = {}
  collectBlankUnits(questions).forEach((blank) => {
    next[blank.blankId] = ''
  })
  return next
}

const gradeQuestion = (question: QuizQuestion, answersById: Record<string, string>): QuestionGrade => {
  const blanks = collectBlankUnits([question])
  let total = 0
  let correct = 0
  const checkedById: Record<string, boolean> = {}

  blanks.forEach((blank) => {
    const user = normalizeCoreCaseSensitive(answersById[blank.blankId] ?? '')
    const expected = normalizeCoreCaseSensitive(blank.answer)
    const isCorrect = user !== '' && user === expected
    total += 1
    if (isCorrect) correct += 1
    checkedById[blank.blankId] = isCorrect
  })

  return { total, correct, checkedById }
}

const toAnswerSentence = (question: QuizQuestion) =>
  question.units
    .map((unit) =>
      unit.kind === 'text' ? unit.token : `${unit.prefix}${unit.answer}${unit.suffix}`,
    )
    .join(' ')

const createEmptyStore = (): LearningStore => ({
  scripts: [],
  quizSessions: [],
  sentenceStatsByScript: {},
})

const normalizeStoreFromRows = (
  scriptRows: ScriptRow[],
  sessionRows: QuizSessionRow[],
  statRows: SentenceStatRow[],
): LearningStore => {
  const sentenceStatsByScript: Record<string, Record<string, SentenceStat>> = {}

  statRows.forEach((row) => {
    const scriptStats = sentenceStatsByScript[row.script_id] ?? {}
    scriptStats[row.sentence_key] = {
      sentenceKey: row.sentence_key,
      number: row.number,
      meaning: row.meaning,
      english: row.english,
      studyRevealCount: row.study_reveal_count,
      quizAttempts: row.quiz_attempts,
      wrongCount: row.wrong_count,
      wrongBlankCount: row.wrong_blank_count,
      lastStudiedAt: row.last_studied_at ?? undefined,
      lastQuizAt: row.last_quiz_at ?? undefined,
    }
    sentenceStatsByScript[row.script_id] = scriptStats
  })

  return {
    scripts: scriptRows.map((row) => ({
      id: row.id,
      title: row.title,
      rawText: row.raw_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at,
    })),
    quizSessions: sessionRows.map((row) => ({
      id: row.id,
      scriptId: row.script_id,
      createdAt: row.created_at,
      totalQuestions: row.total_questions,
      totalBlanks: row.total_blanks,
      correctBlanks: row.correct_blanks,
      wrongSentences: row.wrong_sentences,
      blankRatio: row.blank_ratio,
    })),
    sentenceStatsByScript,
  }
}

const loadRemoteStore = async (username: string): Promise<LearningStore> => {
  if (!supabase) throw new Error('Supabase가 설정되지 않았습니다.')

  const [scriptsResult, sessionsResult, statsResult] = await Promise.all([
    supabase
      .from('scripts')
      .select(
        'id, owner_username, title, raw_text, created_at, updated_at, last_opened_at',
      )
      .eq('owner_username', username)
      .order('updated_at', { ascending: false }),
    supabase
      .from('quiz_sessions')
      .select(
        'id, owner_username, script_id, created_at, total_questions, total_blanks, correct_blanks, wrong_sentences, blank_ratio',
      )
      .eq('owner_username', username)
      .order('created_at', { ascending: false }),
    supabase
      .from('sentence_stats')
      .select(
        'owner_username, script_id, sentence_key, number, meaning, english, study_reveal_count, quiz_attempts, wrong_count, wrong_blank_count, last_studied_at, last_quiz_at',
      )
      .eq('owner_username', username),
  ])

  if (scriptsResult.error) throw scriptsResult.error
  if (sessionsResult.error) throw sessionsResult.error
  if (statsResult.error) throw statsResult.error

  return normalizeStoreFromRows(
    (scriptsResult.data ?? []) as ScriptRow[],
    (sessionsResult.data ?? []) as QuizSessionRow[],
    (statsResult.data ?? []) as SentenceStatRow[],
  )
}

const sentenceKeyOf = (item: QuizItem, index: number) =>
  `${index}:${item.number}:${item.english.toLowerCase().replace(/\s+/g, ' ').trim()}`

function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [username, setUsername] = useState('')
  const [usernameInput, setUsernameInput] = useState('')
  const [syncError, setSyncError] = useState('')
  const [isLoadingStore, setIsLoadingStore] = useState(false)

  const [store, setStore] = useState<LearningStore>(() => createEmptyStore())
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null)
  const [blankRatio, setBlankRatio] = useState(35)

  const [draftTitle, setDraftTitle] = useState('')
  const [draftRawText, setDraftRawText] = useState('')
  const [draftError, setDraftError] = useState('')
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null)

  const [studyIndex, setStudyIndex] = useState(0)
  const [studyRevealed, setStudyRevealed] = useState(false)
  const [studyQueue, setStudyQueue] = useState<number[]>([])
  const [studyUnknownQueue, setStudyUnknownQueue] = useState<number[]>([])
  const [studyScore, setStudyScore] = useState(0)
  const [studyAnsweredCount, setStudyAnsweredCount] = useState(0)
  const [studyDone, setStudyDone] = useState(false)
  const [studyHistory, setStudyHistory] = useState<StudyAnswerHistory[]>([])

  const [quizScriptId, setQuizScriptId] = useState<string | null>(null)
  const [quizItems, setQuizItems] = useState<QuizItem[]>([])
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[]>([])
  const [answersById, setAnswersById] = useState<Record<string, string>>({})
  const [gradesByIndex, setGradesByIndex] = useState<Record<number, QuestionGrade>>({})
  const [currentIndex, setCurrentIndex] = useState(0)
  const [focusSignal, setFocusSignal] = useState(0)
  const [quizBlankRatio, setQuizBlankRatio] = useState(35)
  const [quizError, setQuizError] = useState('')

  const blankInputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const sessionSavedRef = useRef(false)

  const selectedScript = store.scripts.find((script) => script.id === selectedScriptId) ?? null
  const selectedItems = selectedScript ? parseItems(selectedScript.rawText) : []
  const scriptStatsMap = selectedScript
    ? (store.sentenceStatsByScript[selectedScript.id] ?? {})
    : {}
  const scriptStats = Object.values(scriptStatsMap)
  const recentSessions = selectedScript
    ? store.quizSessions
        .filter((session) => session.scriptId === selectedScript.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 6)
    : []

  const totalBlanks = collectBlankUnits(quizQuestions).length
  const isQuizFinished = screen === 'quiz' && currentIndex >= quizQuestions.length
  const currentQuestion = quizQuestions[currentIndex] ?? null
  const currentBlanks = currentQuestion ? collectBlankUnits([currentQuestion]) : []
  const currentGrade = gradesByIndex[currentIndex]
  const firstBlankId = currentBlanks[0]?.blankId ?? ''

  const hydrateStoreForUsername = useCallback(async (targetUsername: string) => {
    setIsLoadingStore(true)
    try {
      const nextStore = await loadRemoteStore(targetUsername)
      setStore(nextStore)
      setSyncError('')
      setSelectedScriptId((prev) =>
        prev && !nextStore.scripts.some((script) => script.id === prev) ? null : prev,
      )
    } catch (error) {
      setStore(createEmptyStore())
      const message = error instanceof Error ? error.message : '알 수 없는 오류'
      setSyncError(`데이터 불러오기 실패: ${toFriendlyDbError(message)}`)
    } finally {
      setIsLoadingStore(false)
    }
  }, [])

  useEffect(() => {
    if (!username) return
    void hydrateStoreForUsername(username)
  }, [username, hydrateStoreForUsername])

  useEffect(() => {
    if (screen !== 'quiz' || isQuizFinished) return
    const rafId = window.requestAnimationFrame(() => {
      const firstInput = blankInputRefs.current[firstBlankId]
      firstInput?.focus()
      firstInput?.select()
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [screen, isQuizFinished, firstBlankId, focusSignal])

  const touchScript = (scriptId: string) => {
    const touchedAt = nowIso()
    setStore((prev) => ({
      ...prev,
      scripts: prev.scripts.map((script) =>
        script.id === scriptId ? { ...script, lastOpenedAt: touchedAt } : script,
      ),
    }))

    if (!supabase || !username) return
    void supabase
      .from('scripts')
      .update({ last_opened_at: touchedAt })
      .eq('id', scriptId)
      .eq('owner_username', username)
      .then(({ error }) => {
        if (error) setSyncError(`지문 열람시간 저장 실패: ${toFriendlyDbError(error.message)}`)
      })
  }

  const upsertSentenceStat = (
    scriptId: string,
    item: QuizItem,
    index: number,
    updater: (stat: SentenceStat) => SentenceStat,
  ) => {
    const sentenceKey = sentenceKeyOf(item, index)
    const currentBucket = store.sentenceStatsByScript[scriptId] ?? {}
    const base: SentenceStat = currentBucket[sentenceKey] ?? {
      sentenceKey,
      number: item.number,
      meaning: item.meaning,
      english: item.english,
      studyRevealCount: 0,
      quizAttempts: 0,
      wrongCount: 0,
      wrongBlankCount: 0,
    }
    const nextStat = updater({
      ...base,
      number: item.number,
      meaning: item.meaning,
      english: item.english,
    })

    setStore((prev) => {
      const scriptBucket = { ...(prev.sentenceStatsByScript[scriptId] ?? {}) }
      scriptBucket[sentenceKey] = nextStat

      return {
        ...prev,
        sentenceStatsByScript: {
          ...prev.sentenceStatsByScript,
          [scriptId]: scriptBucket,
        },
      }
    })

    if (!supabase || !username) return
    void supabase.from('sentence_stats').upsert(
      {
        owner_username: username,
        script_id: scriptId,
        sentence_key: nextStat.sentenceKey,
        number: nextStat.number,
        meaning: nextStat.meaning,
        english: nextStat.english,
        study_reveal_count: nextStat.studyRevealCount,
        quiz_attempts: nextStat.quizAttempts,
        wrong_count: nextStat.wrongCount,
        wrong_blank_count: nextStat.wrongBlankCount,
        last_studied_at: nextStat.lastStudiedAt ?? null,
        last_quiz_at: nextStat.lastQuizAt ?? null,
        updated_at: nowIso(),
      },
      { onConflict: 'owner_username,script_id,sentence_key' },
    )
      .then(({ error }) => {
        if (error) setSyncError(`문장 통계 저장 실패: ${toFriendlyDbError(error.message)}`)
      })
  }

  const submitUsername = () => {
    const nextName = usernameInput.trim()
    if (!nextName) {
      setSyncError('유저네임을 입력해 주세요.')
      return
    }
    setUsername(nextName)
    setUsernameInput('')
    setSyncError('')
    setScreen('home')
    setSelectedScriptId(null)
  }

  const changeUsername = () => {
    setUsername('')
    setUsernameInput('')
    setStore(createEmptyStore())
    setSelectedScriptId(null)
    setSyncError('')
    setScreen('home')
  }

  const reloadStore = () => {
    if (!username) return
    void hydrateStoreForUsername(username)
  }

  const openCreate = () => {
    setEditingScriptId(null)
    setDraftTitle('')
    setDraftRawText('')
    setDraftError('')
    setScreen('create')
  }

  const openEdit = (script: ScriptRecord) => {
    setEditingScriptId(script.id)
    setDraftTitle(script.title)
    setDraftRawText(script.rawText)
    setDraftError('')
    setScreen('create')
  }

  const saveScript = async () => {
    setSyncError('')
    const title = draftTitle.trim()
    const rawText = draftRawText.trim()
    if (!title) {
      setDraftError('제목을 입력해 주세요.')
      return
    }
    if (!rawText) {
      setDraftError('지문을 입력해 주세요.')
      return
    }
    const parsed = parseItems(rawText)
    if (!parsed.length) {
      setDraftError('형식이 맞지 않습니다. `번호. 한글` 다음 줄에 `영어`를 넣어주세요.')
      return
    }

    const timestamp = nowIso()
    const targetId = editingScriptId ?? makeId()

    if (!supabase || !username) {
      setDraftError('Supabase 연결 또는 유저네임 상태를 확인해 주세요.')
      return
    }

    if (editingScriptId) {
      const { error } = await supabase
        .from('scripts')
        .update({
          title,
          raw_text: rawText,
          updated_at: timestamp,
          last_opened_at: timestamp,
        })
        .eq('id', editingScriptId)
        .eq('owner_username', username)
      if (error) {
        setDraftError(`저장 실패: ${toFriendlyDbError(error.message)}`)
        return
      }
    } else {
      const { error } = await supabase.from('scripts').insert({
        id: targetId,
        owner_username: username,
        title,
        raw_text: rawText,
        created_at: timestamp,
        updated_at: timestamp,
        last_opened_at: timestamp,
      })
      if (error) {
        setDraftError(`저장 실패: ${toFriendlyDbError(error.message)}`)
        return
      }
    }

    setStore((prev) => {
      if (editingScriptId) {
        return {
          ...prev,
          scripts: prev.scripts.map((script) =>
            script.id === editingScriptId
              ? {
                  ...script,
                  title,
                  rawText,
                  updatedAt: timestamp,
                  lastOpenedAt: timestamp,
                }
              : script,
          ),
        }
      }

      return {
        ...prev,
        scripts: [
          {
            id: targetId,
            title,
            rawText,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastOpenedAt: timestamp,
          },
          ...prev.scripts,
        ],
      }
    })

    setSelectedScriptId(targetId)
    setDraftError('')
    setScreen('script')
  }

  const openScript = (scriptId: string) => {
    setSelectedScriptId(scriptId)
    touchScript(scriptId)
    setScreen('script')
  }

  const deleteScript = async (scriptId: string) => {
    setSyncError('')
    const confirmed = window.confirm('이 지문과 기록을 삭제할까요?')
    if (!confirmed) return

    if (!supabase || !username) {
      setSyncError('Supabase 연결 또는 유저네임 상태를 확인해 주세요.')
      return
    }

    const { error } = await supabase
      .from('scripts')
      .delete()
      .eq('id', scriptId)
      .eq('owner_username', username)
    if (error) {
      setSyncError(`삭제 실패: ${toFriendlyDbError(error.message)}`)
      return
    }

    setStore((prev) => {
      const nextStats = { ...prev.sentenceStatsByScript }
      delete nextStats[scriptId]
      return {
        ...prev,
        scripts: prev.scripts.filter((script) => script.id !== scriptId),
        quizSessions: prev.quizSessions.filter((session) => session.scriptId !== scriptId),
        sentenceStatsByScript: nextStats,
      }
    })

    if (selectedScriptId === scriptId) {
      setSelectedScriptId(null)
      setScreen('home')
    }
  }

  const startStudy = () => {
    if (!selectedScript || !selectedItems.length) return
    const initialQueue = selectedItems.map((_, index) => index)
    touchScript(selectedScript.id)
    setStudyQueue(initialQueue)
    setStudyUnknownQueue([])
    setStudyIndex(0)
    setStudyScore(0)
    setStudyAnsweredCount(0)
    setStudyDone(false)
    setStudyHistory([])
    setStudyRevealed(false)
    setScreen('study')
  }

  const toggleStudyReveal = () => {
    if (!selectedScript) return
    const sourceIndex = studyQueue[studyIndex]
    const item = sourceIndex === undefined ? null : selectedItems[sourceIndex]
    if (!item) return

    if (!studyRevealed) {
      upsertSentenceStat(selectedScript.id, item, sourceIndex, (stat) => ({
        ...stat,
        studyRevealCount: stat.studyRevealCount + 1,
        lastStudiedAt: nowIso(),
      }))
    }
    setStudyRevealed((prev) => !prev)
  }

  const markStudyCard = (known: boolean) => {
    const sourceIndex = studyQueue[studyIndex]
    const item = sourceIndex === undefined ? null : selectedItems[sourceIndex]
    if (!item) return

    setStudyHistory((prev) => [
      ...prev,
      {
        queue: [...studyQueue],
        unknownQueue: [...studyUnknownQueue],
        index: studyIndex,
        score: studyScore,
        answeredCount: studyAnsweredCount,
        done: studyDone,
        revealed: studyRevealed,
      },
    ])

    const nextUnknownQueue = known
      ? studyUnknownQueue
      : studyUnknownQueue.includes(sourceIndex)
        ? studyUnknownQueue
        : [...studyUnknownQueue, sourceIndex]
    const nextAnsweredCount = studyAnsweredCount + 1
    const nextScore = known ? studyScore + 1 : studyScore

    setStudyUnknownQueue(nextUnknownQueue)
    setStudyAnsweredCount(nextAnsweredCount)
    setStudyScore(nextScore)

    if (studyIndex < studyQueue.length - 1) {
      setStudyIndex((prev) => prev + 1)
      setStudyRevealed(false)
      return
    }

    setStudyDone(true)
    setStudyRevealed(false)
  }

  const undoStudyMark = () => {
    const last = studyHistory[studyHistory.length - 1]
    if (!last) return

    setStudyHistory((prev) => prev.slice(0, -1))
    setStudyQueue(last.queue)
    setStudyUnknownQueue(last.unknownQueue)
    setStudyIndex(last.index)
    setStudyScore(last.score)
    setStudyAnsweredCount(last.answeredCount)
    setStudyDone(last.done)
    setStudyRevealed(last.revealed)
  }

  const retryStudyUnknownOnly = () => {
    if (!studyUnknownQueue.length) return
    setStudyQueue(studyUnknownQueue)
    setStudyUnknownQueue([])
    setStudyIndex(0)
    setStudyScore(0)
    setStudyAnsweredCount(0)
    setStudyDone(false)
    setStudyHistory([])
    setStudyRevealed(false)
  }

  const startQuiz = () => {
    if (!selectedScript) return
    const items = parseItems(selectedScript.rawText)
    if (!items.length) {
      setQuizError('지문 형식을 다시 확인해 주세요.')
      return
    }

    const questions = makeExam(items, blankRatio)
    setQuizScriptId(selectedScript.id)
    setQuizItems(items)
    setQuizQuestions(questions)
    setAnswersById(createEmptyAnswers(questions))
    setCurrentIndex(0)
    setGradesByIndex({})
    setFocusSignal((prev) => prev + 1)
    setQuizBlankRatio(blankRatio)
    setQuizError('')
    sessionSavedRef.current = false
    touchScript(selectedScript.id)
    setScreen('quiz')
  }

  const gradeCurrentQuestion = () => {
    if (!currentQuestion || currentGrade) return
    const grade = gradeQuestion(currentQuestion, answersById)
    setGradesByIndex((prev) => ({ ...prev, [currentIndex]: grade }))

    const sourceItem = quizItems[currentQuestion.sourceIndex]
    if (quizScriptId && sourceItem) {
      upsertSentenceStat(quizScriptId, sourceItem, currentQuestion.sourceIndex, (stat) => ({
        ...stat,
        quizAttempts: stat.quizAttempts + 1,
        wrongCount: stat.wrongCount + (grade.correct < grade.total ? 1 : 0),
        wrongBlankCount: stat.wrongBlankCount + Math.max(0, grade.total - grade.correct),
        lastQuizAt: nowIso(),
      }))
    }
  }

  const saveQuizSessionIfNeeded = () => {
    if (!quizScriptId || sessionSavedRef.current) return

    const final = Object.values(gradesByIndex).reduce(
      (acc, grade) => ({
        total: acc.total + grade.total,
        correct: acc.correct + grade.correct,
      }),
      { total: 0, correct: 0 },
    )
    const wrongSentences = Object.values(gradesByIndex).filter(
      (grade) => grade.correct < grade.total,
    ).length
    const createdAt = nowIso()
    const nextSession: QuizSessionRecord = {
      id: makeId(),
      scriptId: quizScriptId,
      createdAt,
      totalQuestions: quizQuestions.length,
      totalBlanks: final.total,
      correctBlanks: final.correct,
      wrongSentences,
      blankRatio: quizBlankRatio,
    }

    sessionSavedRef.current = true
    setStore((prev) => ({
      ...prev,
      quizSessions: [nextSession, ...prev.quizSessions].slice(0, 500),
    }))

    if (!supabase || !username) return
    void supabase.from('quiz_sessions').insert({
      id: nextSession.id,
      owner_username: username,
      script_id: nextSession.scriptId,
      created_at: nextSession.createdAt,
      total_questions: nextSession.totalQuestions,
      total_blanks: nextSession.totalBlanks,
      correct_blanks: nextSession.correctBlanks,
      wrong_sentences: nextSession.wrongSentences,
      blank_ratio: nextSession.blankRatio,
    })
      .then(({ error }) => {
        if (error) setSyncError(`퀴즈 기록 저장 실패: ${toFriendlyDbError(error.message)}`)
      })
  }

  const goNextQuestion = () => {
    if (!currentQuestion || !currentGrade) return
    if (currentIndex < quizQuestions.length - 1) {
      setCurrentIndex((prev) => prev + 1)
      setFocusSignal((prev) => prev + 1)
      return
    }
    saveQuizSessionIfNeeded()
    setCurrentIndex(quizQuestions.length)
  }

  const moveQuestionForward = () => {
    if (isQuizFinished || !quizQuestions.length) return
    if (currentIndex === quizQuestions.length - 1) {
      if (currentGrade) {
        goNextQuestion()
      }
      return
    }

    setCurrentIndex((prev) => clamp(prev + 1, 0, quizQuestions.length - 1))
    setFocusSignal((prev) => prev + 1)
  }

  const clearCurrentAnswers = () => {
    if (!currentQuestion || currentGrade) return
    const nextAnswers = { ...answersById }
    currentBlanks.forEach((blank) => {
      nextAnswers[blank.blankId] = ''
    })
    setAnswersById(nextAnswers)
  }

  const handleBlankEnter = (blankId: string) => {
    if (currentGrade) {
      goNextQuestion()
      return
    }

    const blankIndex = currentBlanks.findIndex((blank) => blank.blankId === blankId)
    if (blankIndex < 0) return

    const nextBlank = currentBlanks[blankIndex + 1]
    if (nextBlank) {
      const nextInput = blankInputRefs.current[nextBlank.blankId]
      nextInput?.focus()
      nextInput?.select()
      return
    }

    gradeCurrentQuestion()
  }

  const markWrongBlankAsCorrect = (blankId: string, answer: string) => {
    if (!currentGrade || currentGrade.checkedById[blankId]) return

    setAnswersById((prev) => ({ ...prev, [blankId]: answer }))
    setGradesByIndex((prev) => {
      const grade = prev[currentIndex]
      if (!grade || grade.checkedById[blankId]) return prev
      return {
        ...prev,
        [currentIndex]: {
          ...grade,
          correct: Math.min(grade.total, grade.correct + 1),
          checkedById: { ...grade.checkedById, [blankId]: true },
        },
      }
    })
  }

  const wrongIndexes = quizQuestions
    .map((_, index) => index)
    .filter((index) => {
      const grade = gradesByIndex[index]
      return Boolean(grade && grade.correct < grade.total)
    })

  const retryWrongOnly = () => {
    if (!wrongIndexes.length) return

    const wrongItems = wrongIndexes
      .map((index) => {
        const question = quizQuestions[index]
        return question ? quizItems[question.sourceIndex] : null
      })
      .filter((item): item is QuizItem => Boolean(item))
    if (!wrongItems.length) return

    const questions = makeExam(wrongItems, quizBlankRatio)
    setQuizItems(wrongItems)
    setQuizQuestions(questions)
    setAnswersById(createEmptyAnswers(questions))
    setCurrentIndex(0)
    setGradesByIndex({})
    setFocusSignal((prev) => prev + 1)
    sessionSavedRef.current = false
  }

  const finalScore = Object.values(gradesByIndex).reduce(
    (acc, grade) => ({
      total: acc.total + grade.total,
      correct: acc.correct + grade.correct,
    }),
    { total: 0, correct: 0 },
  )

  const solvedCount = isQuizFinished ? quizQuestions.length : Object.keys(gradesByIndex).length
  const progressRatio = quizQuestions.length ? solvedCount / quizQuestions.length : 0

  const sortedScripts = [...store.scripts].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )

  const totalStudyReveal = Object.values(store.sentenceStatsByScript).reduce(
    (acc, scriptBucket) =>
      acc + Object.values(scriptBucket).reduce((sum, stat) => sum + stat.studyRevealCount, 0),
    0,
  )

  const globalConfusing = Object.entries(store.sentenceStatsByScript)
    .flatMap(([scriptId, bucket]) => {
      const title = store.scripts.find((script) => script.id === scriptId)?.title ?? '삭제된 지문'
      return Object.values(bucket).map((stat) => ({ ...stat, scriptTitle: title }))
    })
    .sort((a, b) => {
      if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount
      return b.wrongBlankCount - a.wrongBlankCount
    })
    .slice(0, 6)

  if (!supabase) {
    return (
      <div className="app-shell">
        <main className="page">
          <section className="panel">
            <p className="empty-text">
              Supabase 연결 정보가 없습니다. `.env`의 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
              를 확인해 주세요.
            </p>
          </section>
        </main>
      </div>
    )
  }

  if (!username) {
    return (
      <div className="app-shell">
        <main className="page form-page">
          <section className="panel form-panel username-panel">
            <div className="panel-top">
              <h2>유저네임 설정</h2>
            </div>
            <label className="field">
              <span>유저네임</span>
              <input
                value={usernameInput}
                onChange={(event) => setUsernameInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  submitUsername()
                }}
                placeholder="예: minji-1"
              />
            </label>
            {syncError && <p className="error-text">{syncError}</p>}
            <div className="form-actions">
              <button className="primary-btn" onClick={submitUsername}>
                시작하기
              </button>
            </div>
          </section>
        </main>
      </div>
    )
  }

  if (isLoadingStore) {
    return (
      <div className="app-shell">
        <main className="page">
          <section className="panel">
            <p className="empty-text">{username} 데이터 불러오는 중...</p>
          </section>
        </main>
      </div>
    )
  }

  if (screen === 'home') {
    return (
      <div className="app-shell">
        <main className="page home-page">
          <section className="hero">
            <p className="kicker">Molip English Lab</p>
            <h1>스크립트 단위로 학습과 퀴즈를 관리하세요</h1>
            <p>
              홈에서 새 지문을 만들거나 저장된 기록을 선택하고, 지문 안에서 학습 카드와 빈칸
              퀴즈를 바로 시작할 수 있습니다.
            </p>
            <p className="user-chip">현재 사용자: {username}</p>
            <div className="hero-actions">
              <button className="primary-btn large-btn" onClick={openCreate}>
                새 지문 만들기
              </button>
              <button className="large-btn" onClick={reloadStore}>
                다시 불러오기
              </button>
              <button className="large-btn" onClick={changeUsername}>
                사용자 변경
              </button>
            </div>
            {syncError && <p className="hero-error">{syncError}</p>}
          </section>

          <section className="stat-grid">
            <article className="stat-card">
              <p>저장 지문</p>
              <strong>{store.scripts.length}</strong>
            </article>
            <article className="stat-card">
              <p>퀴즈 기록</p>
              <strong>{store.quizSessions.length}</strong>
            </article>
            <article className="stat-card">
              <p>학습 뒤집기</p>
              <strong>{totalStudyReveal}</strong>
            </article>
          </section>

          <section className="panel">
            <div className="panel-top">
              <h2>지문 기록</h2>
            </div>
            {!sortedScripts.length ? (
              <p className="empty-text">아직 저장된 지문이 없습니다. 첫 지문을 만들어 주세요.</p>
            ) : (
              <div className="script-grid">
                {sortedScripts.map((script) => {
                  const itemCount = parseItems(script.rawText).length
                  const sessionCount = store.quizSessions.filter(
                    (session) => session.scriptId === script.id,
                  ).length
                  return (
                    <article key={script.id} className="script-card">
                      <p className="script-title">{script.title}</p>
                      <p className="script-meta">
                        문장 {itemCount}개 · 퀴즈 {sessionCount}회
                      </p>
                      <p className="script-date">최근 열람 {formatDateTime(script.lastOpenedAt)}</p>
                      <div className="card-actions">
                        <button className="primary-btn" onClick={() => openScript(script.id)}>
                          열기
                        </button>
                        <button onClick={() => openEdit(script)}>수정</button>
                        <button
                          className="danger-btn"
                          onClick={() => {
                            void deleteScript(script.id)
                          }}
                        >
                          삭제
                        </button>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-top">
              <h2>헷갈린 문장 Top</h2>
            </div>
            {!globalConfusing.length ? (
              <p className="empty-text">퀴즈를 풀면 헷갈린 문장이 자동으로 누적됩니다.</p>
            ) : (
              <div className="insight-list">
                {globalConfusing.map((stat) => (
                  <article key={`${stat.scriptTitle}-${stat.sentenceKey}`} className="insight-item">
                    <p className="insight-head">
                      [{stat.scriptTitle}] {stat.number}. {stat.meaning}
                    </p>
                    <p className="insight-body">{stat.english}</p>
                    <p className="insight-foot">
                      오답 {stat.wrongCount}회 · 오답 빈칸 {stat.wrongBlankCount}개
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>
      </div>
    )
  }

  if ((screen === 'script' || screen === 'study') && !selectedScript) {
    return (
      <div className="app-shell">
        <main className="page">
          <section className="panel">
            <p className="empty-text">선택한 지문을 찾을 수 없습니다.</p>
            <button onClick={() => setScreen('home')}>홈으로</button>
          </section>
        </main>
      </div>
    )
  }

  if (screen === 'create') {
    return (
      <div className="app-shell">
        <main className="page form-page">
          <section className="panel form-panel">
            <div className="panel-top">
              <h2>{editingScriptId ? '지문 수정' : '새 지문 만들기'}</h2>
              <button onClick={() => setScreen('home')}>홈으로</button>
            </div>

            <label className="field">
              <span>제목</span>
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="예: 중2 1과 본문"
              />
            </label>

            <p className="format-guide">
              입력 형식: `번호. 한글 뜻` 다음 줄에 `영어 문장`을 넣어 주세요. 대괄호 줄은 자동으로
              무시됩니다.
            </p>

            <label className="field">
              <span>지문</span>
              <textarea
                value={draftRawText}
                onChange={(event) => setDraftRawText(event.target.value)}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                placeholder={
                  '형식 안내\n번호. 한글 뜻\n영어 문장\n\n번호. 한글 뜻\n영어 문장'
                }
              />
            </label>

            {draftError && <p className="error-text">{draftError}</p>}

            <div className="form-actions">
              <button
                className="primary-btn"
                onClick={() => {
                  void saveScript()
                }}
              >
                저장하고 열기
              </button>
              <button onClick={() => setScreen('home')}>취소</button>
            </div>
          </section>
        </main>
      </div>
    )
  }

  if (screen === 'script' && selectedScript) {
    const topConfusing = [...scriptStats]
      .sort((a, b) => {
        if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount
        return b.wrongBlankCount - a.wrongBlankCount
      })
      .slice(0, 7)

    return (
      <div className="app-shell">
        <main className="page script-page">
          <section className="panel script-panel">
            <div className="panel-top">
              <h2>{selectedScript.title}</h2>
              <button onClick={() => setScreen('home')}>홈으로</button>
            </div>

            <p className="script-detail">
              문장 {selectedItems.length}개 · 최근 열람 {formatDateTime(selectedScript.lastOpenedAt)}
            </p>

            <div className="hub-actions">
              <button className="primary-btn large-btn" onClick={startStudy}>
                카드 학습 시작
              </button>
              <button className="primary-btn large-btn" onClick={startQuiz}>
                퀴즈 시작
              </button>
              <button onClick={() => openEdit(selectedScript)}>지문 수정</button>
            </div>

            <div className="ratio-box">
              <label htmlFor="blankRatio">빈칸 비율: {blankRatio}%</label>
              <input
                id="blankRatio"
                type="range"
                min={15}
                max={80}
                step={5}
                value={blankRatio}
                onChange={(event) => setBlankRatio(Number(event.target.value))}
              />
              <p>비율을 높일수록 한 문장에서 가려지는 단어 수가 늘어납니다.</p>
            </div>

            {quizError && <p className="error-text">{quizError}</p>}
          </section>

          <section className="panel">
            <div className="panel-top">
              <h2>최근 문제 기록</h2>
            </div>
            {!recentSessions.length ? (
              <p className="empty-text">아직 퀴즈 기록이 없습니다.</p>
            ) : (
              <div className="session-list">
                {recentSessions.map((session) => (
                  <article key={session.id} className="session-item">
                    <p>{formatDateTime(session.createdAt)}</p>
                    <p>
                      {session.correctBlanks} / {session.totalBlanks} · 오답 문장 {session.wrongSentences}
                      개 · 빈칸 비율 {session.blankRatio}%
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-top">
              <h2>헷갈리는 문장 분석</h2>
            </div>
            {!topConfusing.length ? (
              <p className="empty-text">학습/퀴즈를 진행하면 문장별 헷갈림 데이터가 누적됩니다.</p>
            ) : (
              <div className="insight-list">
                {topConfusing.map((stat) => (
                  <article key={stat.sentenceKey} className="insight-item">
                    <p className="insight-head">
                      {stat.number}. {stat.meaning}
                    </p>
                    <p className="insight-body">{stat.english}</p>
                    <p className="insight-foot">
                      오답 {stat.wrongCount}회 · 오답 빈칸 {stat.wrongBlankCount}개 · 카드 열람{' '}
                      {stat.studyRevealCount}회
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>
      </div>
    )
  }

  if (screen === 'study' && selectedScript) {
    if (studyDone) {
      const wrongSet = new Set(studyUnknownQueue)
      const wrongItems = studyQueue
        .filter((sourceIndex) => wrongSet.has(sourceIndex))
        .map((sourceIndex) => selectedItems[sourceIndex])
        .filter((entry): entry is QuizItem => Boolean(entry))

      return (
        <div className="app-shell">
          <main className="page study-page">
            <section className="panel study-panel study-done">
              <div className="panel-top">
                <h2>카드 학습 완료</h2>
                <button onClick={() => setScreen('script')}>스크립트로</button>
              </div>
              <p className="study-status">
                총 {studyQueue.length}장 중 {studyScore}장 아는 카드 · {studyUnknownQueue.length}장 모르는
                카드
              </p>

              {studyUnknownQueue.length > 0 ? (
                <section className="wrong-review">
                  <p className="wrong-title">모르는 카드 {studyUnknownQueue.length}개</p>
                  <div className="wrong-list">
                    {wrongItems.map((wrongItem, index) => (
                      <article
                        key={`${wrongItem.number}-${index}-${wrongItem.english}`}
                        className="wrong-item"
                      >
                        <p className="wrong-head">
                          {wrongItem.number}. {wrongItem.meaning}
                        </p>
                        <p className="wrong-answer">{wrongItem.english}</p>
                      </article>
                    ))}
                  </div>
                  <button className="primary-btn wrong-only-btn" onClick={retryStudyUnknownOnly}>
                    모르는 카드만 다시
                  </button>
                </section>
              ) : (
                <p className="all-correct">모든 카드를 아는 카드로 분류했습니다.</p>
              )}

              <div className="study-actions">
                <button className="primary-btn" onClick={startStudy}>
                  처음부터 다시
                </button>
                <button onClick={() => setScreen('script')}>스크립트 허브로</button>
              </div>
            </section>
          </main>
        </div>
      )
    }

    const sourceIndex = studyQueue[studyIndex]
    const item = sourceIndex === undefined ? null : selectedItems[sourceIndex]
    if (!item || !studyQueue.length) {
      return (
        <div className="app-shell">
          <main className="page">
            <section className="panel">
              <p className="empty-text">학습할 문장이 없습니다.</p>
              <button onClick={() => setScreen('script')}>스크립트로 돌아가기</button>
            </section>
          </main>
        </div>
      )
    }

    return (
      <div className="app-shell">
        <main className="page study-page">
          <section className="panel study-panel">
            <div className="panel-top">
              <h2>카드 학습</h2>
              <button onClick={() => setScreen('script')}>스크립트로</button>
            </div>
            <p className="study-progress">
              {studyIndex + 1} / {studyQueue.length}
            </p>
            <p className="study-meta">
              아는 카드 {studyScore}장 · 모르는 카드 {studyUnknownQueue.length}장
            </p>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.round((studyAnsweredCount / Math.max(1, studyQueue.length)) * 100)}%`,
                }}
              />
            </div>

            <button className={`study-card ${studyRevealed ? 'revealed' : ''}`} onClick={toggleStudyReveal}>
              <p className="study-number">{item.number}번</p>
              <p className="study-meaning">{item.meaning}</p>
              {studyRevealed && <p className="study-english">{item.english}</p>}
              <span>{studyRevealed ? '클릭해서 다시 가리기' : '클릭해서 정답 보기'}</span>
            </button>

            <div className="study-actions">
              <button className="warning-btn" onClick={() => markStudyCard(false)}>
                몰라요
              </button>
              <button
                className="icon-circle-btn"
                onClick={undoStudyMark}
                disabled={!studyHistory.length}
                aria-label="이전 카드로 되돌리기"
                title="이전 카드로 되돌리기"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M9 7H5v4M5 11a7 7 0 1 0 2.1-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button className="success-btn" onClick={() => markStudyCard(true)}>
                아는거
              </button>
            </div>
          </section>
        </main>
      </div>
    )
  }

  if (screen === 'quiz') {
    return (
      <div className="app-shell">
        <main className="page quiz-page">
          <section className="panel quiz-header">
            <div className="panel-top">
              <h2>빈칸 퀴즈</h2>
              <button onClick={() => setScreen('script')}>스크립트로</button>
            </div>
            <div className="progress-row">
              <div className="progress-left">
                <strong>
                  채점 진행도 {solvedCount} / {quizQuestions.length}
                </strong>
                <span>총 빈칸 {totalBlanks}개</span>
              </div>
              {!isQuizFinished && (
                <div className="progress-nav">
                  <span>
                    {currentIndex + 1} / {quizQuestions.length}
                  </span>
                  <button
                    onClick={moveQuestionForward}
                    disabled={currentIndex === quizQuestions.length - 1 && !currentGrade}
                    aria-label="다음 문제로 이동"
                  >
                    →
                  </button>
                </div>
              )}
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.round(progressRatio * 100)}%` }}
              />
            </div>
          </section>

          {isQuizFinished ? (
            <section className="panel result-panel">
              <p className="result-label">완료</p>
              <p className="result-score">
                {finalScore.correct} / {finalScore.total}
              </p>
              <p className="result-percent">
                {Math.round((finalScore.correct / Math.max(1, finalScore.total)) * 100)}점
              </p>

              {wrongIndexes.length > 0 ? (
                <section className="wrong-review">
                  <p className="wrong-title">틀린 문장 {wrongIndexes.length}개</p>
                  <div className="wrong-list">
                    {wrongIndexes.map((index) => {
                      const question = quizQuestions[index]
                      const grade = gradesByIndex[index]
                      if (!question || !grade) return null

                      const wrongBlanks = collectBlankUnits([question]).filter(
                        (blank) => !grade.checkedById[blank.blankId],
                      )

                      return (
                        <article key={`${question.number}-${index}`} className="wrong-item">
                          <p className="wrong-head">
                            {question.number}. {question.meaning}
                          </p>
                          <p className="wrong-answer">정답 문장: {toAnswerSentence(question)}</p>
                          {!!wrongBlanks.length && (
                            <p className="wrong-blank-list">
                              {wrongBlanks
                                .map((blank) => {
                                  const user = (answersById[blank.blankId] ?? '').trim()
                                  return `${user || '(빈칸)'} → ${blank.answer}`
                                })
                                .join(' · ')}
                            </p>
                          )}
                        </article>
                      )
                    })}
                  </div>
                  <button className="primary-btn wrong-only-btn" onClick={retryWrongOnly}>
                    틀린 문장만 다시 풀기
                  </button>
                </section>
              ) : (
                <p className="all-correct">전부 정답입니다.</p>
              )}

              <div className="result-actions">
                <button className="primary-btn" onClick={startQuiz}>
                  같은 지문으로 새 퀴즈
                </button>
                <button onClick={() => setScreen('script')}>스크립트 허브로</button>
              </div>
            </section>
          ) : (
            <section className="panel question-panel">
              <button
                className="reset-icon-btn"
                onClick={clearCurrentAnswers}
                disabled={Boolean(currentGrade)}
                aria-label="현재 문장 입력 초기화"
                title="현재 문장 입력 초기화"
              >
                ↺
              </button>

              <div className="question-top">
                <p className="q-number">
                  {currentQuestion?.number}. <span>{currentIndex + 1}번째 문장</span>
                </p>
                {currentGrade && (
                  <p className="q-score">
                    이번 문장 {currentGrade.correct} / {currentGrade.total}
                  </p>
                )}
              </div>

              <p className="q-meaning">뜻: {currentQuestion?.meaning}</p>
              <div className="q-sentence-wrap">
                <p className="label">문장</p>
                <div className="sentence-line">
                  {currentQuestion?.units.map((unit, index) => {
                    if (unit.kind === 'text') {
                      return (
                        <span className="token" key={`${currentQuestion.number}-text-${index}`}>
                          {unit.token}
                        </span>
                      )
                    }

                    const isChecked = currentGrade?.checkedById[unit.blankId]
                    const statusClass = isChecked === undefined ? '' : isChecked ? 'correct' : 'wrong'

                    return (
                      <span className="blank-cluster token" key={unit.blankId}>
                        {unit.prefix}
                        <input
                          className={`blank-input ${statusClass}`}
                          style={{ width: `${unit.width}px` }}
                          value={answersById[unit.blankId] ?? ''}
                          readOnly={Boolean(currentGrade)}
                          ref={(node) => {
                            blankInputRefs.current[unit.blankId] = node
                          }}
                          onChange={(event) => {
                            if (currentGrade) return
                            const nextValue = event.target.value
                            setAnswersById((prev) => ({ ...prev, [unit.blankId]: nextValue }))
                          }}
                          onClick={() => {
                            if (!currentGrade || isChecked) return
                            markWrongBlankAsCorrect(unit.blankId, unit.answer)
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter') return
                            event.preventDefault()
                            handleBlankEnter(unit.blankId)
                          }}
                          autoCapitalize="none"
                          autoCorrect="off"
                          aria-label={`${currentQuestion.number}번 빈칸`}
                        />
                        {unit.suffix}
                        {currentGrade && !isChecked && (
                          <button
                            className="answer-note"
                            onClick={() => markWrongBlankAsCorrect(unit.blankId, unit.answer)}
                          >
                            {unit.answer}
                          </button>
                        )}
                      </span>
                    )
                  })}
                </div>
              </div>

              <div className="action-bar">
                <button
                  className={`primary-btn next-btn ${currentGrade ? 'arrow-mode' : ''}`}
                  onClick={currentGrade ? goNextQuestion : gradeCurrentQuestion}
                  aria-label={currentGrade ? '다음 문장으로 이동' : '현재 문장 채점'}
                >
                  {currentGrade ? '→' : '채점'}
                </button>
              </div>
            </section>
          )}
        </main>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <main className="page">
        <section className="panel">
          <p className="empty-text">유효한 화면 상태가 아닙니다.</p>
          <button onClick={() => setScreen('home')}>홈으로</button>
        </section>
      </main>
    </div>
  )
}

export default App
