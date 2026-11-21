// Nội dung các video mẫu tự tạo. Đáp án đúng nằm ngay cạnh câu hỏi → make-samples sinh answers.json.
// `speech`: TTS đọc; `layout`: cách dựng hình. Video thật của người dùng thì bỏ thẳng vào eval/videos/.

const mcq = (number, text, options, answer) => ({ number, text, options, answer });

export const SAMPLES = [
  {
    name: 'mcq-grammar',
    note: 'Trắc nghiệm ngữ pháp, mỗi câu một màn hình, có giọng đọc câu hỏi',
    size: [1280, 720],
    layout: 'one-per-slide',
    speakQuestions: true,
    questions: [
      mcq('1', 'She ____ to school every day.', ['go', 'goes', 'going', 'gone'], 'B'),
      mcq('2', 'If I ____ you, I would apologize.', ['am', 'was', 'were', 'be'], 'C'),
      mcq('3', 'They have lived here ____ 2010.', ['for', 'since', 'from', 'in'], 'B'),
      mcq('4', 'This is the ____ book I have ever read.', ['good', 'better', 'best', 'most good'], 'C'),
      mcq('5', 'He asked me where ____.', ['did I live', 'I lived', 'do I live', 'I live'], 'B'),
    ],
  },
  {
    name: 'fill-blank',
    note: 'Điền từ, 3 câu mỗi màn hình, video KHÔNG có tiếng',
    size: [1280, 720],
    layout: 'three-per-slide',
    title: 'Complete the sentences with the correct form or word.',
    questions: [
      { number: '1', text: 'Yesterday we ____ (go) to the cinema.', answer: 'went' },
      { number: '2', text: 'She has ____ (write) three letters this morning.', answer: 'written' },
      { number: '3', text: 'Look! The children ____ (play) in the garden.', answer: 'are playing' },
      { number: '4', text: 'I am interested ____ learning Japanese.', answer: 'in' },
      { number: '5', text: 'He is ____ (tall) than his brother.', answer: 'taller' },
      { number: '6', text: 'There are not ____ (some / any) apples left in the basket.', answer: 'any' },
    ],
  },
  {
    name: 'reading',
    note: 'Đọc hiểu: một màn hình đoạn văn, sau đó câu hỏi; không có tiếng',
    size: [1280, 720],
    layout: 'passage-then-pairs',
    passage:
      "Maria moved to Lisbon in 2019 to work as a nurse at a children's hospital. At first she found the language difficult, so she took evening classes twice a week. After a year she could talk to her patients without help. In her free time Maria enjoys cycling along the river, but she never rides when it rains.",
    questions: [
      mcq('1', 'Why did Maria move to Lisbon?', ['To study Portuguese', 'To work as a nurse', 'To open a hospital', 'To go cycling'], 'B'),
      mcq('2', 'How often did she take evening classes?', ['Once a week', 'Twice a week', 'Every evening', 'Twice a month'], 'B'),
      { number: '3', text: 'True or False: After one year Maria still needed help to talk to her patients.', answer: 'False' },
      mcq('4', 'What does Maria do in her free time when the weather is dry?', ['She cycles along the river', 'She swims in the river', 'She takes evening classes', 'She works at night'], 'A'),
    ],
  },
  {
    name: 'listening',
    note: 'Đề nghe: màn hình chỉ có câu hỏi, đáp án CHỈ nằm trong audio',
    size: [1280, 720],
    layout: 'pairs',
    title: 'Listening — Part 1. Listen and answer.',
    speech:
      'Listen to the conversation and answer the questions. Good morning. I would like to book a table for Friday evening. Certainly. For how many people? There will be six of us. And what time would you like to come? At half past seven, please. Could I have your name? Yes, it is Mister Baker. Thank you, Mister Baker. Your table for six is booked for Friday at seven thirty.',
    questions: [
      mcq('1', 'Which day is the table booked for?', ['Thursday', 'Friday', 'Saturday'], 'B'),
      mcq('2', 'How many people will come?', ['four', 'five', 'six'], 'C'),
      mcq('3', 'What time is the booking?', ['7:00', '7:30', '8:30'], 'B'),
      { number: '4', text: "The customer's surname is ____.", answer: 'Baker' },
    ],
  },
  {
    name: 'small-change',
    note: 'Ứng dụng quiz 1080p: khung giao diện đứng yên, chỉ một vùng chữ nhỏ đổi mỗi 3 giây',
    size: [1920, 1080],
    layout: 'quiz-app',
    questions: [
      mcq('1', 'The opposite of "ancient" is:', ['modern', 'old', 'huge', 'quiet'], 'A'),
      mcq('2', 'A person who writes books is an:', ['actor', 'author', 'artist', 'athlete'], 'B'),
      mcq('3', 'Choose the correct spelling:', ['recieve', 'receive', 'receeve', 'receve'], 'B'),
      mcq('4', '"Purchase" means:', ['sell', 'borrow', 'buy', 'lend'], 'C'),
      mcq('5', 'The plural of "child" is:', ['childs', 'childes', 'children', 'childrens'], 'C'),
      mcq('6', 'Which word is a verb?', ['happy', 'quickly', 'decide', 'table'], 'C'),
    ],
  },
  {
    name: 'scroll',
    note: 'Quay màn hình điện thoại dọc, cuộn qua một trang 8 câu',
    size: [1080, 1920],
    layout: 'scroll',
    title: 'Grammar Test — Unit 5',
    questions: [
      mcq('1', 'I ____ my homework before dinner yesterday.', ['finish', 'finished', 'have finished', 'finishing'], 'B'),
      mcq('2', 'There ____ any milk in the fridge.', ["isn't", "aren't", 'not', "don't"], 'A'),
      mcq('3', 'She is good ____ playing the piano.', ['in', 'on', 'at', 'with'], 'C'),
      mcq('4', 'We ____ TV when the phone rang.', ['watched', 'were watching', 'are watching', 'watch'], 'B'),
      mcq('5', 'You ____ smoke in the hospital. It is forbidden.', ["mustn't", "don't have to", "needn't", 'might not'], 'A'),
      mcq('6', 'This house ____ in 1920.', ['built', 'was built', 'is building', 'has built'], 'B'),
      mcq('7', 'How ____ money do you have?', ['many', 'much', 'few', 'long'], 'B'),
      mcq('8', 'My brother is ____ engineer.', ['a', 'an', 'the', 'no article'], 'B'),
    ],
  },
];
