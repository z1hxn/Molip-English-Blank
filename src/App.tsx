import { useEffect, useRef, useState } from 'react'
import './App.css'

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
  units: SentenceUnit[]
}

type QuestionGrade = {
  total: number
  correct: number
  checkedById: Record<string, boolean>
}

const SAMPLE_INPUT = `109. 깜짝 파티는 나를 설레게 했다.
Surprise parties make me excited.

110. 그는 매일 영어를 공부한다.
He studies English every day.

[Listen and Write]
111. 우리는 내일 도서관에서 만날 것이다.
We will meet at the library tomorrow.`

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

const makeQuestion = (item: QuizItem): QuizQuestion => {
  const tokens = item.english.split(/\s+/).filter(Boolean)
  const candidates = tokens
    .map((token, index) => ({ index, core: normalizeCoreLower(token) }))
    .filter(({ core }) => core.length > 2 && !STOP_WORDS.has(core))
    .map(({ index }) => index)

  const fallback = tokens
    .map((token, index) => ({ index, core: normalizeCoreLower(token) }))
    .filter(({ core }) => core.length > 0)
    .map(({ index }) => index)

  const blankCount = Math.min(tokens.length, Math.max(2, Math.round(tokens.length * 0.35)))
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
      width: Math.max(82, Math.min(210, core.length * 16)),
    }
  })

  return {
    number: item.number,
    meaning: item.meaning,
    units,
  }
}

const makeExam = (items: QuizItem[]) => items.map((item) => makeQuestion(item))

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

function App() {
  const [mode, setMode] = useState<'builder' | 'exam'>('builder')
  const [input, setInput] = useState(SAMPLE_INPUT)
  const [error, setError] = useState('')
  const [sourceItems, setSourceItems] = useState<QuizItem[]>([])
  const [questions, setQuestions] = useState<QuizQuestion[]>([])
  const [answersById, setAnswersById] = useState<Record<string, string>>({})
  const [currentIndex, setCurrentIndex] = useState(0)
  const [gradesByIndex, setGradesByIndex] = useState<Record<number, QuestionGrade>>({})
  const [focusSignal, setFocusSignal] = useState(0)
  const blankInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const totalBlanks = collectBlankUnits(questions).length
  const isFinished = mode === 'exam' && currentIndex >= questions.length
  const currentQuestion = questions[currentIndex] ?? null
  const currentBlanks = currentQuestion ? collectBlankUnits([currentQuestion]) : []
  const currentGrade = gradesByIndex[currentIndex]
  const firstBlankId = currentBlanks[0]?.blankId ?? ''

  useEffect(() => {
    if (mode !== 'exam' || isFinished) return

    const rafId = window.requestAnimationFrame(() => {
      const firstInput = blankInputRefs.current[firstBlankId]
      firstInput?.focus()
      firstInput?.select()
    })

    return () => window.cancelAnimationFrame(rafId)
  }, [firstBlankId, focusSignal, mode, isFinished])

  const makeExamFromInput = () => {
    const parsed = parseItems(input)
    if (!parsed.length) {
      setError('입력 형식이 맞지 않습니다. `번호. 한글` 다음 줄에 `영어`를 넣어주세요.')
      return
    }

    const nextQuestions = makeExam(parsed)
    setError('')
    setSourceItems(parsed)
    setQuestions(nextQuestions)
    setAnswersById(createEmptyAnswers(nextQuestions))
    setCurrentIndex(0)
    setGradesByIndex({})
    setMode('exam')
  }

  const rebuildExam = () => {
    if (!sourceItems.length) return
    const nextQuestions = makeExam(sourceItems)
    setQuestions(nextQuestions)
    setAnswersById(createEmptyAnswers(nextQuestions))
    setCurrentIndex(0)
    setGradesByIndex({})
  }

  const clearCurrentAnswers = () => {
    if (!currentQuestion) return
    const nextAnswers = { ...answersById }
    currentBlanks.forEach((blank) => {
      nextAnswers[blank.blankId] = ''
    })
    setAnswersById(nextAnswers)
    setGradesByIndex((prev) => {
      if (!(currentIndex in prev)) return prev
      const next = { ...prev }
      delete next[currentIndex]
      return next
    })
  }

  const gradeCurrentQuestion = () => {
    if (!currentQuestion) return
    const grade = gradeQuestion(currentQuestion, answersById)
    setGradesByIndex((prev) => ({ ...prev, [currentIndex]: grade }))
    setFocusSignal((prev) => prev + 1)
  }

  const goNextQuestion = () => {
    if (!currentQuestion || !currentGrade) return
    if (currentIndex < questions.length - 1) {
      setCurrentIndex((prev) => prev + 1)
      setFocusSignal((prev) => prev + 1)
      return
    }
    setCurrentIndex(questions.length)
  }

  const goPrevQuestion = () => {
    if (currentIndex <= 0 || isFinished) return
    setCurrentIndex((prev) => prev - 1)
  }

  const handleBlankEnter = (blankId: string) => {
    const blankIndex = currentBlanks.findIndex((blank) => blank.blankId === blankId)
    if (blankIndex < 0) return

    const nextBlank = currentBlanks[blankIndex + 1]
    if (nextBlank) {
      const nextInput = blankInputRefs.current[nextBlank.blankId]
      nextInput?.focus()
      nextInput?.select()
      return
    }

    if (currentGrade) {
      goNextQuestion()
      return
    }

    gradeCurrentQuestion()
  }

  const returnToBuilder = () => {
    setMode('builder')
    setCurrentIndex(0)
    setGradesByIndex({})
  }

  const finalScore = Object.values(gradesByIndex).reduce(
    (acc, grade) => ({
      total: acc.total + grade.total,
      correct: acc.correct + grade.correct,
    }),
    { total: 0, correct: 0 },
  )

  const solvedCount = isFinished ? questions.length : currentIndex
  const progressRatio = questions.length ? solvedCount / questions.length : 0
  const wrongIndexes = questions
    .map((_, index) => index)
    .filter((index) => {
      const grade = gradesByIndex[index]
      return Boolean(grade && grade.correct < grade.total)
    })

  const startWrongOnlyReview = () => {
    if (!wrongIndexes.length) return

    const wrongNumbers = new Set(wrongIndexes.map((index) => questions[index]?.number))
    const wrongSourceItems = sourceItems.filter((item) => wrongNumbers.has(item.number))
    if (!wrongSourceItems.length) return

    const nextQuestions = makeExam(wrongSourceItems)
    setQuestions(nextQuestions)
    setAnswersById(createEmptyAnswers(nextQuestions))
    setCurrentIndex(0)
    setGradesByIndex({})
    setFocusSignal((prev) => prev + 1)
  }

  if (mode === 'builder') {
    return (
      <div className="builder-shell">
        <section className="builder-panel">
          <p className="brand">Molip English Blank</p>
          <h1>지문을 넣으면 시험지로 전환됩니다</h1>
          <p className="desc">형식: `번호. 한글` 다음 줄 `영어` (대괄호 줄/여러 빈 줄 자동 무시)</p>

          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="builder-input"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
          />

          <div className="builder-controls">
            <button className="primary-btn" onClick={makeExamFromInput}>
              시험 시작
            </button>
            <button
              onClick={() => {
                setInput(SAMPLE_INPUT)
                setError('')
              }}
            >
              샘플 지문
            </button>
          </div>

          {error && <p className="error-text">{error}</p>}
        </section>
      </div>
    )
  }

  return (
    <div className="exam-shell">
      <header className="exam-header">
        <p className="paper-label">English Dictation Test</p>
        <h1>Molip 시험지</h1>
        <p className="meta">한 문장씩 채점하고 다음 문장으로 이동합니다.</p>
      </header>

      <section className="progress-panel">
        <div className="progress-row">
          <strong>
            진행도 {Math.min(solvedCount + 1, questions.length)} / {questions.length}
          </strong>
          <span>총 빈칸 {totalBlanks}개</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.round(progressRatio * 100)}%` }} />
        </div>
      </section>

      {isFinished ? (
        <section className="final-panel">
          <p className="final-title">시험 완료</p>
          <p className="final-score">
            {finalScore.correct} / {finalScore.total}
          </p>
          <p className="final-percent">
            {Math.round((finalScore.correct / Math.max(1, finalScore.total)) * 100)}점
          </p>
          {wrongIndexes.length > 0 ? (
            <section className="wrong-review">
              <p className="wrong-title">틀린 문제 {wrongIndexes.length}개</p>
              <div className="wrong-list">
                {wrongIndexes.map((index) => {
                  const question = questions[index]
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
                              return `${user || '(빈칸)'} -> ${blank.answer}`
                            })
                            .join(' · ')}
                        </p>
                      )}
                    </article>
                  )
                })}
              </div>
              <button className="primary-btn wrong-only-btn" onClick={startWrongOnlyReview}>
                틀린 문제만 다시 풀기
              </button>
            </section>
          ) : (
            <p className="all-correct">전부 정답입니다.</p>
          )}
          <div className="final-controls">
            <button className="primary-btn" onClick={rebuildExam}>
              새 시험지로 다시 풀기
            </button>
            <button onClick={returnToBuilder}>입력 화면으로</button>
          </div>
        </section>
      ) : (
        <main className="question-card">
          <button className="reset-icon-btn" onClick={clearCurrentAnswers} aria-label="현재 문장 초기화" title="현재 문장 초기화">
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
                      ref={(node) => {
                        blankInputRefs.current[unit.blankId] = node
                      }}
                      onChange={(event) => {
                        const nextValue = event.target.value
                        setAnswersById((prev) => ({ ...prev, [unit.blankId]: nextValue }))
                        if (currentGrade) {
                          setGradesByIndex((prev) => {
                            const next = { ...prev }
                            delete next[currentIndex]
                            return next
                          })
                        }
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
                    {currentGrade && !isChecked && <span className="answer-note">{unit.answer}</span>}
                  </span>
                )
              })}
            </div>
          </div>

          <div className="action-bar">
            <button onClick={goPrevQuestion} disabled={currentIndex === 0}>
              뒤로
            </button>
            <button
              className={`primary-btn next-btn ${currentGrade ? 'arrow-mode' : ''}`}
              onClick={currentGrade ? goNextQuestion : gradeCurrentQuestion}
              aria-label={currentGrade ? '다음 문장으로 이동' : '현재 문장 채점'}
            >
              {currentGrade ? '→' : '채점'}
            </button>
          </div>
        </main>
      )}
    </div>
  )
}

export default App
