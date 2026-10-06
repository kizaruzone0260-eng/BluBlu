import { readFileSync, writeFileSync } from 'node:fs';
const base = 'C:/Users/Surface Book 3/Desktop/BluBlu/packages/shared/src/locales';

// Each section: { h: heading, b: [paragraphs] }. The same section/paragraph COUNT
// is used for ru/uz/en so the locale-keys parity test (recursive over arrays) stays green.
const S = (h, ...b) => ({ h, b });

const ru = {
  privacy: {
    title: 'Политика конфиденциальности',
    version: 'Версия документов: 2026-10-06',
    intro: 'BluBlu — учебная платформа, которую устанавливает и администрирует владелец (учебное заведение или преподаватель). Этот текст — черновик: правовую проверку выполняет владелец.',
    sections: [
      S('Кто отвечает за данные', 'Оператором персональных данных является владелец экземпляра BluBlu. Контакт для обращений по данным: [указать e-mail/должность владельца].'),
      S('Какие данные мы обрабатываем', 'Данные аккаунта: адрес электронной почты, имя и фамилия, язык интерфейса и часовой пояс.', 'Учебный контент, который создают пользователи: классы, материалы и файлы, заметки, сообщения чата, события календаря, доски и листки учеников.', 'По желанию — идентификатор Telegram-чата (chat_id) для уведомлений.', 'Номер сборки и технические идентификаторы (uuid) сами по себе персональными данными не являются.'),
      S('Технические журналы', 'Сервер записывает IP-адрес запроса, время, метод и путь запроса для диагностики и безопасности.', 'Строки запроса (query) с токенами и билеты WebSocket из журналов вырезаются; пароли и секреты не записываются.'),
      S('Правовые основания', 'Обработка нужна для оказания образовательной услуги (исполнение договора/уставных целей) и выполняется на основании согласия, которое запрашивается при регистрации и при первом входе.'),
      S('Кто обрабатывает данные за нас (процессоры)', 'Render — хостинг приложения (регион Франкфурт, ЕС).', 'Supabase — управляемая база данных PostgreSQL (регион Франкфурт, ЕС).', 'LiveKit — сервер видеосвязи; в демо-режиме используется LiveKit Cloud, при самостоятельной установке медиа остаётся на сервере владельца.', 'Telegram Bot API — получает chat_id и текст уведомления, только если пользователь сам привязал Telegram.'),
      S('Передача данных', 'Инфраструктура размещения расположена во Франкфурте (ЕС).', 'Внешние запросы из интерфейса ограничены и происходят только по действию пользователя: например, встроенное видео YouTube открывается через youtube-nocookie.com после нажатия.'),
      S('Сроки хранения', 'Данные аккаунта и учебный контент хранятся, пока аккаунт или класс активны.', 'Журнал действий (audit_log) и сообщения чата хранятся до удаления соответствующего аккаунта или класса.', 'При полном удалении аккаунта персональные данные анонимизируются (адрес почты сбрасывается), а заметки ученика, листки, членства в классах, привязка Telegram и токены сессий удаляются каскадно. Материалы и объявления, созданные преподавателем, остаются доступными классу, для которого они были созданы.'),
      S('Полное удаление аккаунта', 'Удалить аккаунт можно самостоятельно в разделе «Профиль». Действие необратимо; часть учебного контента, созданного для класса, сохраняется в интересах участников класса (см. раздел о сроках хранения).'),
      S('Что хранится в браузере', 'Только необходимое: сессия входа (защищённая cookie, недоступная скриптам), выбранный язык и тема оформления, локальные настройки интерфейса (например, положение плавающего окна камеры).', 'Аналитики и рекламных трекеров нет, поэтому баннер о cookie не требуется.'),
      S('Несовершеннолетние', 'Сервис предназначен для занятий под руководством преподавателя. Порядок подтверждения возраста и согласия законного представителя определяет владелец. [заполнить владельцу]'),
      S('Ваши права', 'Вы можете просматривать и изменять свои данные в «Профиле» и удалить аккаунт. По иным вопросам обработки обращайтесь к владельцу (контакт выше).'),
      S('Изменение документов', 'При появлении новой версии документов запрашивается повторное согласие при следующем входе; версия хранится вместе с отметкой времени принятия.'),
    ],
  },
  terms: {
    title: 'Пользовательское соглашение',
    version: 'Версия документов: 2026-10-06',
    intro: 'Условия использования платформы BluBlu. Текст — черновик: правовую проверку выполняет владелец.',
    sections: [
      S('Предмет', 'BluBlu предоставляет средства для проведения занятий: материалы, задания, календарь, заметки, чат и видеоуроки. Сервис предоставляется «как есть».'),
      S('Аккаунт', 'Вы отвечаете за сохранность своих учётных данных и за действия, выполненные под вашей учётной записью. Одна учётная запись предназначена для одного человека.'),
      S('Правила использования', 'Запрещены вредоносный контент, нарушение прав других лиц, спам и попытки обойти ограничения доступа или безопасности.'),
      S('Контент и права', 'Права на созданные материалы остаются у их автора. Размещение материала в классе означает разрешение показать его участникам этого класса.'),
      S('Доступность', 'Доступ может прерываться из-за плановых работ и особенностей инфраструктуры; непрерывная работа не гарантируется.'),
      S('Ограничение ответственности', 'Владелец не несёт ответственности за косвенные убытки и за работу внешних сервисов (видеосвязи, Telegram). [уточнить владельцу]'),
      S('Прекращение использования', 'Вы можете удалить аккаунт в любой момент. Владелец вправе приостановить доступ при нарушении этих условий.'),
      S('Изменение условий и контакты', 'О существенных изменениях условий пользователи узнают при следующем входе (повторное принятие версии). Контакт владельца: [указать].'),
    ],
  },
  consent: {
    regCheckbox: 'Я прочитал(а) и принимаю Политику конфиденциальности и Пользовательское соглашение',
    mustAccept: 'Чтобы продолжить, примите Политику конфиденциальности и Пользовательское соглашение.',
    gateTitle: 'Ознакомьтесь и примите условия',
    gateBody: 'Мы обновили правовые документы. Пожалуйста, прочитайте и примите их, чтобы продолжить работу.',
    privacyLink: 'Политика конфиденциальности',
    termsLink: 'Пользовательское соглашение',
    accept: 'Принять',
    decline: 'Отказаться и выйти',
    versionNote: 'Версия документов: {{version}}',
  },
  legalLinks: { privacy: 'Политика', terms: 'Условия', back: '← Назад' },
};

const uz = {
  privacy: {
    title: 'Maxfiylik siyosati',
    version: 'Hujjatlar versiyasi: 2026-10-06',
    intro: 'BluBlu — egasi (o‘quv muassasasi yoki o‘qituvchi) o‘rnatadigan va boshqaradigan o‘quv platformasi. Ushbu matn — qoralama: huquqiy tekshiruvni egasi bajaradi.',
    sections: [
      S('Ma‘lumotlarga kim javobgar', 'Shaxsiy ma‘lumotlar operatori — BluBlu nusxasining egasi. Ma‘lumotlar bo‘yicha murojaat: [egasi e-mail/lavozimini kiriting].'),
      S('Qanday ma‘lumotlarni ishlaymiz', 'Hisob ma‘lumotlari: elektron pochta, ism va familiya, interfeys tili va vaqt mintaqasi.', 'Foydalanuvchilar yaratadigan o‘quv kontenti: sinflar, material va fayllar, eslatmalar, chat xabarlari, calendar voqealari, doskalar va o‘quvchi varaqalari.', 'Ixtiyoriy — xabarnomalar uchun Telegram chat identifikatori (chat_id).', 'Build raqami va texnik identifikatorlar (uuid) o‘z-o‘ziga shaxsiy ma‘lumot hisoblanmaydi.'),
      S('Texnik jurnallar', 'Server diagnostika va xavfsizlik uchun so‘rov IP manzilini, vaqtini, metodini va yo‘lini yozadi.', 'Tokenli so‘rov qatorlari (query) va WebSocket chiptalari jurnallardan qirqiladi; parollar va sirlar yozilmaydi.'),
      S('Huquqiy asoslar', 'Ishlov ta‘lim xizmatini ko‘rsatish uchun zarur (shartnoma/ba‘dnav maqsadlarini bajarish) va ro‘yxatdan o‘tish hamda birinchi kirishda so‘raladigan rozilik asosida amalga oshiriladi.'),
      S('Ma‘lumotlarni biz uchun kim qayta ishlaydi (protsessorlar)', 'Render — ilova hostingi (Frankfurt, YE).', 'Supabase — boshqariladigan PostgreSQL bazasi (Frankfurt, YE).', 'LiveKit — video aloqa serveri; demo rejimida LiveKit Cloud ishlatiladi, o‘zi o‘rnatilganda media egasi serverida qoladi.', 'Telegram Bot API — foydalanuvchi Telegramni o‘zi bog‘lagandagina chat_id va xabarnoma matnini oladi.'),
      S('Ma‘lumot uzatish', 'Joylashtirish infratuzilmasi Frankfurtda (YE).', 'Interfeysdan tashqi so‘rovlar cheklangan va faqat foydalanuvchi harakati bilan bo‘ladi: masalan, YouTube videosi bosilgandan keyingina youtube-nocookie.com orqali ochiladi.'),
      S('Saqlash muddatlari', 'Hisob ma‘lumotlari va o‘quv kontenti hisob yoki sinf faol bo‘lguncha saqlanadi.', 'Amallar jurnali (audit_log) va chat xabarlari tegishli hisob yoki sinf o‘chirilgungacha saqlanadi.', 'Hisob to‘liq o‘chirilganda shaxsiy ma‘lumotlar nomlashadi (pochta bekor qilinadi), o‘quvchi eslatmalari, varaqalari, sinf a‘zoligi, Telegram bog‘lanishi va sessiya tokenlari kaskad o‘chiriladi. O‘qituvchi yaratgan material va e‘lonlar o‘sha sinf uchun ochiq qoladi.'),
      S('Hisobni to‘liq o‘chirish', 'Hisobni «Profil» bo‘limida o‘zingiz o‘chira olasiz. Amal qaytarib bo‘lmaydi; sinf uchun yaratilgan ba‘zi kontent sinf a‘zolari manfaatiga saqlanib qoladi (saqlash muddatlari bo‘limiga qarang).'),
      S('Brauzerda nima saqlanadi', 'Faqat zarur narsalar: kirish sessiyasi (skriptlar kira olmaydigan himoyalangan cookie), tanlangan til va mavzu, interfeys sozlamalari (masalan, suzuvchi kamera oynasi joylashuvi).', 'Analitika va reklama trekerlari yo‘q, shuning uchun cookie banneri talab qilinmaydi.'),
      S('Voyaga yetmaganlar', 'Servis o‘qituvchi rahbarligida darslar uchun mo‘ljallangan. Yosh va qonuniy vakil roziligini tasdiqlash tartibini egasi belgilaydi. [egasi to‘ldiradi]'),
      S('Sizning huquqlaringiz', 'Ma‘lumotlaringizni «Profil»da ko‘rishingiz, tahrirlashingiz va hisobni o‘chirishingiz mumkin. Boshqa savollar uchun egaga murojaat qiling (yuqoridagi kontakt).'),
      S('Hujjatlarni o‘zgartirish', 'Yangi versiya paydo bo‘lganda keyingi kirishda qayta rozilik so‘raladi; versiya qabul qilinish vaqti belgisi bilan saqlanadi.'),
    ],
  },
  terms: {
    title: 'Foydalanish shartlari',
    version: 'Hujjatlar versiyasi: 2026-10-06',
    intro: 'BluBlu platformasidan foydalanish shartlari. Matn — qoralama: huquqiy tekshiruvni egasi bajaradi.',
    sections: [
      S('Mavzu', 'BluBlu dars o‘tkazish vositalarini beradi: material, topshiriq, calendar, eslatma, chat va video darslar. Servis «tayyor holicha» taqdim etiladi.'),
      S('Hisob', 'O‘z hisob ma‘lumotlaringiz xavfsizligi va hisobingizda bajarilgan amallar uchun siz javobsiz. Bitta hisob bitta kishiga mo‘ljallangan.'),
      S('Foydalanish qoidalari', 'Zararli kontent, boshqalarning huquqini buzish, spam va kirish yoki xavfsizlik cheklovlarini aylanib o‘tishga urinishlar taqiqlanadi.'),
      S('Kontent va huquqlar', 'Yaratilgan materiallar ustidan huquq muallifda qoladi. Materialni sinfga joylashtirish — uni shu sinf a‘zolariga ko‘rsatishga rozilik bildirishdir.'),
      S('Mavjudlik', 'Rejali ishlar va infratuzilma xususiyatlari tufayli kirish uzilishi mumkin; uzluksiz ishlash kafolatlanmaydi.'),
      S('Javobgarlikni cheklash', 'Ega bilvosita zarars va tashqi servislarning (video aloqa, Telegram) ishlashi uchun javob bermaydi. [egasi aniqlashtiradi]'),
      S('Foydalanishni tugatish', 'Hisobni istalgan vaqtda o‘chira olasiz. Ega bu shartlar buzilganda kirishni to‘xtatish huquqiga ega.'),
      S('Shartlarni o‘zgartirish va kontaktlar', 'Muhim o‘zgarishlar haqida foydalanuvchilar keyingi kirishda biladi (versiyani qayta qabul qilish). Ega kontaktilari: [kiriting].'),
    ],
  },
  consent: {
    regCheckbox: 'Men Maxfiylik siyosatini va Foydalanish shartlarini o‘qib chiqdim va qabul qilaman',
    mustAccept: 'Davom etish uchun Maxfiylik siyosati va Foydalanish shartlarini qabul qiling.',
    gateTitle: 'Shartlar bilan tanishing va qabul qiling',
    gateBody: 'Biz huquqiy hujjatlarni yangiladik. Davom etish uchun iltimos, o‘qib chiqing va qabul qiling.',
    privacyLink: 'Maxfiylik siyosati',
    termsLink: 'Foydalanish shartlari',
    accept: 'Qabul qilish',
    decline: 'Rad etish va chiqish',
    versionNote: 'Hujjatlar versiyasi: {{version}}',
  },
  legalLinks: { privacy: 'Siyosat', terms: 'Shartlar', back: '← Orqaga' },
};

const en = {
  privacy: {
    title: 'Privacy Policy',
    version: 'Document version: 2026-10-06',
    intro: 'BluBlu is a learning platform installed and administered by its owner (a school or a teacher). This text is a draft: legal review is the owner’s responsibility.',
    sections: [
      S('Who is responsible for the data', 'The data controller is the owner of this BluBlu instance. Contact for data requests: [enter the owner’s e-mail/role].'),
      S('What data we process', 'Account data: email address, first and last name, interface language and time zone.', 'Learning content users create: classes, materials and files, notes, chat messages, calendar events, boards and student sheets.', 'Optionally — your Telegram chat identifier (chat_id) for notifications.', 'The build number and technical identifiers (uuid) are not personal data by themselves.'),
      S('Technical logs', 'The server records the request IP address, time, method and path for diagnostics and security.', 'Query strings containing tokens and WebSocket tickets are stripped from logs; passwords and secrets are never recorded.'),
      S('Legal bases', 'Processing is necessary to deliver the education service (performance of a contract/statutory purpose) and is carried out on the basis of consent requested at registration and on first login.'),
      S('Who processes data for us (processors)', 'Render — application hosting (Frankfurt region, EU).', 'Supabase — managed PostgreSQL database (Frankfurt region, EU).', 'LiveKit — the video-conferencing server; LiveKit Cloud is used in demo mode, and with a self-hosted setup media stays on the owner’s server.', 'Telegram Bot API — receives the chat_id and notification text only if the user links Telegram themselves.'),
      S('Data transfers', 'Hosting infrastructure is located in Frankfurt (EU).', 'Outbound requests from the interface are limited and happen only on user action: for example, an embedded YouTube video opens via youtube-nocookie.com only after a click.'),
      S('Retention', 'Account data and learning content are kept while the account or class is active.', 'The action log (audit_log) and chat messages are kept until the corresponding account or class is deleted.', 'On full account deletion personal data is anonymized (the email is reset), and student notes, sheets, class memberships, the Telegram link and session tokens are removed by cascade. Materials and announcements created by a teacher stay available to the class they were created for.'),
      S('Full account deletion', 'You can delete your account yourself under “Profile”. The action is irreversible; some learning content created for a class is kept in the interest of that class’s members (see the retention section).'),
      S('What is stored in the browser', 'Only what is necessary: the login session (a secure cookie not readable by scripts), the chosen language and theme, and local interface settings (for example, the floating camera window position).', 'There is no analytics or advertising tracking, so a cookie banner is not required.'),
      S('Minors', 'The service is intended for lessons under a teacher’s supervision. The procedure for verifying age and obtaining a legal guardian’s consent is defined by the owner. [owner to complete]'),
      S('Your rights', 'You can view and edit your data under “Profile” and delete your account. For other processing questions contact the owner (contact above).'),
      S('Changes to these documents', 'When a new version appears, re-consent is requested on the next login; the accepted version is stored together with its timestamp.'),
    ],
  },
  terms: {
    title: 'Terms of Service',
    version: 'Document version: 2026-10-06',
    intro: 'Terms for using the BluBlu platform. This text is a draft: legal review is the owner’s responsibility.',
    sections: [
      S('Scope', 'BluBlu provides tools for running lessons: materials, assignments, a calendar, notes, chat and video lessons. The service is provided “as is”.'),
      S('Your account', 'You are responsible for keeping your credentials safe and for actions taken under your account. One account is intended for one person.'),
      S('Acceptable use', 'Malicious content, infringing others’ rights, spam, and attempts to bypass access or security restrictions are prohibited.'),
      S('Content and rights', 'Rights to the materials you create remain with their author. Posting a material to a class grants permission to show it to that class’s members.'),
      S('Availability', 'Access may be interrupted by planned maintenance and infrastructure characteristics; uninterrupted operation is not guaranteed.'),
      S('Limitation of liability', 'The owner is not liable for indirect damages or for the operation of external services (video conferencing, Telegram). [owner to refine]'),
      S('Termination', 'You may delete your account at any time. The owner may suspend access for violation of these terms.'),
      S('Changes and contacts', 'You will learn of material changes at your next login (by re-accepting the version). Owner contact: [enter].'),
    ],
  },
  consent: {
    regCheckbox: 'I have read and accept the Privacy Policy and the Terms of Service',
    mustAccept: 'To continue, please accept the Privacy Policy and the Terms of Service.',
    gateTitle: 'Please review and accept',
    gateBody: 'We have updated the legal documents. Please read and accept them to continue.',
    privacyLink: 'Privacy Policy',
    termsLink: 'Terms of Service',
    accept: 'Accept',
    decline: 'Decline and sign out',
    versionNote: 'Document version: {{version}}',
  },
  legalLinks: { privacy: 'Privacy', terms: 'Terms', back: '← Back' },
};

for (const [lang, add] of [['ru', ru], ['uz', uz], ['en', en]]) {
  const p = `${base}/${lang}.json`;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.privacy = add.privacy;
  j.terms = add.terms;
  j.consent = add.consent;
  j.legalLinks = add.legalLinks;
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  // structural parity assertion
  const sig = (o) => JSON.stringify(o, (k, v) => Array.isArray(v) ? v.map(() => '·') : v);
  console.log(lang, 'privacy.sections=', add.privacy.sections.length, 'terms.sections=', add.terms.sections.length);
}
console.log('done');
