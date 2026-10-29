import type { HwItemKind, HwLang, HwMaterialKind } from './types.js';

type Loc = Record<HwLang, string>;

/**
 * Own text table for the homework module. Kept apart from bot.ts's `T`: that table
 * belongs to the existing dialogs, and this module must be removable without touching
 * them. All three product languages are present, as everywhere else in the bot.
 */
export const H = {
  denied: {
    ru: 'Извините, эта команда доступна только учителю с привязанным аккаунтом BluBlu.',
    uz: 'Kechirasiz, bu buyruq BluBlu hisobiga bog‘langan o‘qituvchi uchun.',
    en: 'Sorry, this command is for a teacher with a linked BluBlu account.',
  },
  error: {
    ru: 'Не получилось выполнить действие. Попробуйте ещё раз.',
    uz: 'Amalni bajarib bo‘lmadi. Qayta urinib ko‘ring.',
    en: 'That action did not go through. Please try again.',
  },
  badButton: {
    ru: 'Кнопка устарела или не для вас. Откройте /homework заново.',
    uz: 'Tugma eskirgan yoki sizga tegishli emas. /homework ni qayta oching.',
    en: 'This button is stale or not yours. Open /homework again.',
  },
  cancel: { ru: 'Отмена', uz: 'Bekor qilish', en: 'Cancel' },
  cancelled: {
    ru: 'Черновик отменён. Ничего не опубликовано.',
    uz: 'Qoralama bekor qilindi. Hech narsa e’lon qilinmadi.',
    en: 'Draft cancelled. Nothing was published.',
  },
  back: { ru: 'Назад', uz: 'Orqaga', en: 'Back' },

  selectTitle: {
    ru: 'Домашнее задание. Выберите группы (отмечено: %{n}):',
    uz: 'Uy vazifasi. Guruhlarni tanlang (belgilangan: %{n}):',
    en: 'Homework. Choose groups (%{n} selected):',
  },
  selectHint: {
    ru: 'Материалы собираются в черновик и никуда не публикуются до вашего подтверждения.',
    uz: 'Materiallar qoralamaga yig‘iladi va siz tasdiqlamaguningizcha hech qayerga chiqmaydi.',
    en: 'Materials go into a draft and are not published anywhere until you confirm.',
  },
  noGroups: {
    ru: 'Пока нет подключённых групп. Подключите Telegram-группу — класс BluBlu не нужен.',
    uz: 'Hozircha guruh yo‘q. Telegram guruhini ulang — BluBlu sinfi shart emas.',
    en: 'No groups connected yet. Connect a Telegram group — no BluBlu class is needed.',
  },
  addGroup: { ru: '➕ Подключить группу', uz: '➕ Guruh ulash', en: '➕ Connect a group' },
  startCollect: { ru: '✅ Начать сбор (%{n})', uz: '✅ Yig‘ishni boshlash (%{n})', en: '✅ Start collecting (%{n})' },
  continueBtn: {
    ru: '✅ Продолжить (%{n})',
    uz: '✅ Davom etish (%{n})',
    en: '✅ Continue (%{n})',
  },
  backToHomework: {
    ru: '✅ К заданию (%{n})',
    uz: '✅ Vazifaga qaytish (%{n})',
    en: '✅ Back to the homework (%{n})',
  },
  online: { ru: 'онлайн', uz: 'onlayn', en: 'online' },
  offline: { ru: 'офлайн', uz: 'oflayn', en: 'offline' },
  groupRemoved: {
    ru: 'Группа отключена. История отправок сохранена.',
    uz: 'Guruh uzildi. Yuborishlar tarixi saqlandi.',
    en: 'Group disconnected. Send history is kept.',
  },
  groupRemove: { ru: 'Удалить группу', uz: 'Guruhni o‘chirish', en: 'Remove group' },
  groupRemoveConfirm: {
    ru: 'Отключить группу «%{g}»? Черновик останется, но отправлять в неё будет нельзя.',
    uz: '«%{g}» guruhi uzilsinmi? Qoralama qoladi, lekin unga yuborib bo‘lmaydi.',
    en: 'Disconnect “%{g}”? The draft stays, but nothing can be sent there.',
  },
  groupRemoveYes: { ru: 'Да, отключить', uz: 'Ha, uzish', en: 'Yes, disconnect' },
  groupMissing: {
    ru: 'Группа не найдена или отключена.',
    uz: 'Guruh topilmadi yoki uzilgan.',
    en: 'Group not found or disconnected.',
  },
  groupManageTitle: {
    ru: 'Ваши группы для домашних заданий:',
    uz: 'Uy vazifalari uchun guruhlaringiz:',
    en: 'Your homework groups:',
  },
  manageGroups: { ru: 'Управление группами', uz: 'Guruhlarni boshqarish', en: 'Manage groups' },
  groupManageHint: {
    ru: 'Тип «онлайн/офлайн» — только подпись в списке. На отправку он не влияет.',
    uz: '«Onlayn/oflayn» — faqat ro‘yxatdagi belgi. Yuborishga ta’sir qilmaydi.',
    en: '“Online/offline” is only a label in the list; it does not change delivery.',
  },
  groupCount: { ru: 'Групп: %{n}', uz: 'Guruhlar: %{n}', en: 'Groups: %{n}' },
  tooManyGroups: {
    ru: 'Достигнут предел в %{n} групп. Отключите ненужную и повторите.',
    uz: '%{n} guruh chegarasiga yetdingiz. Keraksizini uzib, qayta urinib ko‘ring.',
    en: 'The limit of %{n} groups is reached. Disconnect one and try again.',
  },
  groupFallback: { ru: 'Группа %{id}', uz: '%{id} guruhi', en: 'Group %{id}' },
  setOnline: { ru: 'Сделать онлайн', uz: 'Onlayn qilish', en: 'Mark online' },
  setOffline: { ru: 'Сделать офлайн', uz: 'Oflayn qilish', en: 'Mark offline' },

  bindCodeTitle: {
    ru: 'Код для подключения группы: %{code}',
    uz: 'Guruhni ulash kodi: %{code}',
    en: 'Group connection code: %{code}',
  },
  bindInstructions: {
    ru: '1. Добавьте бота в группу и сделайте администратором.\n2. Отправьте в группе: /bind %{code}\nКод действует 30 минут и срабатывает один раз.\n\nБот ответит в группе и пришлёт подтверждение сюда.',
    uz: '1. Botni guruhga qo‘shing va administrator qiling.\n2. Guruhda yuboring: /bind %{code}\nKod 30 daqiqa amal qiladi va bir marta ishlaydi.\n\nBot guruhda javob beradi va tasdiqni shu yerga yuboradi.',
    en: '1. Add the bot to the group and make it an administrator.\n2. Send in the group: /bind %{code}\nThe code works for 30 minutes and only once.\n\nThe bot answers in the group and confirms back here.',
  },
  bindBotName: {
    ru: 'Добавьте бота @%{bot} в группу и сделайте администратором.',
    uz: '@%{bot} botini guruhga qo‘shing va administrator qiling.',
    en: 'Add @%{bot} to the group and make it an administrator.',
  },
  bindBotGeneric: {
    ru: 'Добавьте этого бота в группу и сделайте администратором.',
    uz: 'Shu botni guruhga qo‘shing va administrator qiling.',
    en: 'Add this bot to the group and make it an administrator.',
  },
  bindGroupOk: {
    ru: 'Группа «%{g}» подключена. Публикации будут приходить сюда.',
    uz: '«%{g}» guruhi ulandi. E’lonlar shu yerga keladi.',
    en: 'Group “%{g}” is connected. Publications will arrive here.',
  },
  bindDm: {
    ru: 'Группа «%{g}» подключена. Вернитесь в личный чат: /homework',
    uz: '«%{g}» guruhi ulandi. Shaxsiy chatga qayting: /homework',
    en: 'Group “%{g}” is connected. Return to the private chat: /homework',
  },
  bindInvalid: {
    ru: 'Код не найден, уже использован или истёк. Создайте новый в /homework.',
    uz: 'Kod topilmadi, ishlatilgan yoki muddati tugagan. /homework da yangisini yarating.',
    en: 'Code not found, already used or expired. Create a new one in /homework.',
  },
  bindUsage: {
    ru: 'Формат: /bind КОД. Код создаётся в личном чате командой /homework.',
    uz: 'Format: /bind KOD. Kod shaxsiy chatda /homework orqali yaratiladi.',
    en: 'Format: /bind CODE. Create the code in the private chat with /homework.',
  },
  bindNotAdmin: {
    ru: 'Код может применить только администратор этой группы.',
    uz: 'Kodni faqat shu guruh administratori ishlata oladi.',
    en: 'Only an administrator of this group can use the code.',
  },
  bindWrongAccount: {
    ru: 'Код создан другим аккаунтом. Войдите в тот аккаунт, который его создал.',
    uz: 'Kod boshqa hisob tomonidan yaratilgan. Uni yaratgan hisobga kiring.',
    en: 'This code was created by another account. Use the account that created it.',
  },
  bindLegalRequired: {
    ru: 'Сначала примите действующие Политику конфиденциальности и Условия в личном чате с ботом: отправьте /start.',
    uz: 'Avval bot bilan shaxsiy chatda amaldagi Maxfiylik siyosati va Shartlarni qabul qiling: /start yuboring.',
    en: 'First accept the current Privacy Policy and Terms in the private chat with the bot: send /start.',
  },

  collectTitle: {
    ru: 'Сбор материалов. Сохранено: %{n}.',
    uz: 'Materiallar yig‘ilmoqda. Saqlandi: %{n}.',
    en: 'Collecting materials. Saved: %{n}.',
  },
  collectHint: {
    ru: 'Присылайте текстом, фото, файлом или пересланное сообщение — всё попадёт в черновик.\nПосле каждого сообщения я коротко подтверждаю, сколько материалов собрано.',
    uz: 'Matn, foto, fayl yoki forward qilingan xabar yuboring — hammasi qoralamaga tushadi.\nHar xabardan keyin yig‘ilgan materiallar sonini qisqacha tasdiqlayman.',
    en: 'Send text, a photo, a file or a forwarded message — everything lands in the draft.\nAfter each one I confirm briefly how many materials are collected.',
  },
  collectMaterials: {
    ru: 'Выбрано из библиотеки: %{m}',
    uz: 'Kutubxonadan tanlandi: %{m}',
    en: 'From the library: %{m}',
  },
  doneCta: {
    ru: 'Готово — подготовить задание',
    uz: 'Tayyor — vazifani tayyorlash',
    en: 'Done — prepare homework',
  },
  collectAck: {
    ru: '✓ Получено — %{n}',
    uz: '✓ Qabul qilindi — %{n}',
    en: '✓ Received — %{n}',
  },
  collectUnsupported: {
    ru: 'Этот тип пока не поддерживается. Пришлите текст, ссылку, фото или документ.',
    uz: 'Bu tur hozircha qo‘llab-quvvatlanmaydi. Matn, havola, foto yoki hujjat yuboring.',
    en: 'This type is not supported yet. Send text, a link, a photo or a document.',
  },
  collectTooMany: {
    ru: 'В черновике уже %{n} материалов — это максимум. Нажмите «Готово».',
    uz: 'Qoralamada %{n} material bor — bu eng ko‘p. «Tayyor» ni bosing.',
    en: 'The draft already has %{n} materials — the maximum. Press “Done”.',
  },
  collectTooLong: {
    ru: 'Слишком длинный материал. Сократите до %{n} символов.',
    uz: 'Material juda uzun. %{n} belgigacha qisqartiring.',
    en: 'This material is too long. Shorten it to %{n} characters.',
  },
  collectTooBig: {
    ru: 'Файл больше допустимых %{n} МБ.',
    uz: 'Fayl ruxsat etilgan %{n} MB dan katta.',
    en: 'The file is larger than the allowed %{n} MB.',
  },
  kindText: { ru: 'текст', uz: 'matn', en: 'text' },
  kindLink: { ru: 'ссылка', uz: 'havola', en: 'link' },
  kindPhoto: { ru: 'фото', uz: 'foto', en: 'photo' },
  kindDocument: { ru: 'документ', uz: 'hujjat', en: 'document' },
  addPrompt: {
    ru: 'Пришлите материал, который нужно добавить. После этого нажмите «Готово — оформить задание».',
    uz: 'Qo‘shiladigan materialni yuboring. So‘ng «Tayyor — vazifani rasmiylashtirish» ni bosing.',
    en: 'Send the material to add. Then press “Done — format the homework”.',
  },
  editPrompt: {
    ru: 'Пришлите новый текст задания одним сообщением (до %{n} символов). /cancel — отмена.',
    uz: 'Vazifaning yangi matnini bitta xabarda yuboring (%{n} belgigacha). /cancel — bekor qilish.',
    en: 'Send the new homework text in one message (up to %{n} characters). /cancel — cancel.',
  },
  editTooLong: {
    ru: 'Текст длиннее %{n} символов. Сократите его.',
    uz: 'Matn %{n} belgidan uzun. Qisqartiring.',
    en: 'The text is longer than %{n} characters. Shorten it.',
  },
  editDone: {
    ru: 'Текст заменён. Ниже — новый предпросмотр.',
    uz: 'Matn almashtirildi. Quyida yangi ko‘rinish.',
    en: 'Text replaced. The new preview is below.',
  },
  editCancelled: {
    ru: 'Редактирование отменено. Предпросмотр не изменился.',
    uz: 'Tahrirlash bekor qilindi. Ko‘rinish o‘zgarmadi.',
    en: 'Editing cancelled. The preview did not change.',
  },
  changeGroups: { ru: 'Изменить группы', uz: 'Guruhlarni o‘zgartirish', en: 'Change groups' },

  /*
   * One short line, no instructions. The old text told the teacher not to press again — the
   * server already handles a repeated press (compare-and-swap on the draft, a unique row per
   * draft and group), and a warning she cannot act on is noise.
   */
  formatting: {
    ru: 'Готовлю задание…',
    uz: 'Vazifa tayyorlanmoqda…',
    en: 'Preparing the homework…',
  },
  formatFailed: {
    ru: 'Не удалось оформить задание: %{reason}\nМатериалы сохранены. Попробуйте «Готово» ещё раз.',
    uz: 'Vazifani rasmiylashtirib bo‘lmadi: %{reason}\nMateriallar saqlangan. «Tayyor» ni qayta bosing.',
    en: 'Could not format the homework: %{reason}\nMaterials are saved. Press “Done” again.',
  },
  formatUnavailable: {
    ru: 'сервис оформления недоступен',
    uz: 'rasmiylashtirish xizmati mavjud emas',
    en: 'the formatting service is unavailable',
  },
  clarifyTitle: {
    ru: 'Нужно уточнение, прежде чем оформлять:',
    uz: 'Rasmiylashtirishdan oldin aniqlik kerak:',
    en: 'A clarification is needed before formatting:',
  },
  clarifyHint: {
    ru: 'Ответьте одним или несколькими сообщениями — они добавятся к материалам. Затем нажмите «Готово — оформить задание».',
    uz: 'Bir yoki bir nechta xabar bilan javob bering — ular materiallarga qo‘shiladi. So‘ng «Tayyor — vazifani rasmiylashtirish» ni bosing.',
    en: 'Answer with one or more messages — they are added to the materials. Then press “Done — format the homework”.',
  },
  noMaterials: {
    ru: 'В черновике пока ничего нет. Пришлите текст, ссылку, фото или документ — либо выберите материал из библиотеки.',
    uz: 'Qoralamada hozircha hech narsa yo‘q. Matn, havola, foto yoki hujjat yuboring — yoki kutubxonadan material tanlang.',
    en: 'The draft is empty. Send text, a link, a photo or a document — or pick a material from the library.',
  },
  noTargets: {
    ru: 'Не выбрано ни одной активной группы. Вернитесь к выбору групп.',
    uz: 'Faol guruh tanlanmagan. Guruh tanlashga qayting.',
    en: 'No active group is selected. Go back to group selection.',
  },
  hwDefaultTitle: {
    ru: 'Домашнее задание',
    uz: 'Uy vazifasi',
    en: 'Homework',
  },
  aiClarifyFallback: {
    ru: 'Уточните, пожалуйста, детали задания и пришлите их сюда.',
    uz: 'Iltimos, vazifa tafsilotlarini aniqlashtirib, shu yerga yuboring.',
    en: 'Please clarify the details of the homework and send them here.',
  },
  aiWarnAttachments: {
    ru: 'Вложения (%{names}) уйдут в группы как файлы. Их содержимое не анализируется — ИИ видит только названия. Проверьте формулировку перед отправкой.',
    uz: 'Ilovalar (%{names}) guruh fayllari sifatida yuboriladi. Mazmuni tahlil qilinmaydi — AI faqat nomlarni ko‘radi. Yuborishdan oldin matnni tekshiring.',
    en: 'The attachments (%{names}) go to the groups as files. Their contents are not analysed — the AI only sees the names. Check the wording before sending.',
  },
  aiWarnForeignNumbers: {
    ru: 'В тексте есть числа, которых не было в материалах: %{nums}. Проверьте их.',
    uz: 'Matnda materiallarda bo‘lmagan raqamlar bor: %{nums}. Ularni tekshiring.',
    en: 'The text contains numbers that were not in the materials: %{nums}. Please check them.',
  },
  aiWarnForeignDates: {
    ru: 'В тексте есть срок или день недели, которого учитель не указывал: %{words}. Проверьте перед отправкой.',
    uz: 'Matnda o‘qituvchi ko‘rsatmagan muddat yoki kun bor: %{words}. Yuborishdan oldin tekshiring.',
    en: 'The text mentions a deadline or weekday the teacher never wrote: %{words}. Check it before sending.',
  },

  previewTitle: {
    ru: 'Предпросмотр задания для групп (%{n}):',
    uz: 'Guruhlar uchun vazifa ko‘rinishi (%{n}):',
    en: 'Homework preview for groups (%{n}):',
  },
  previewGroups: { ru: 'Кому: %{g}', uz: 'Kimga: %{g}', en: 'To: %{g}' },
  previewMaterials: { ru: 'Материалы: %{m}', uz: 'Materiallar: %{m}', en: 'Materials: %{m}' },
  previewInstruction: { ru: 'Инструкция: %{i}', uz: 'Ko‘rsatma: %{i}', en: 'Instruction: %{i}' },
  previewAttachmentFor: { ru: '📎 «%{g}» — %{a}', uz: '📎 «%{g}» — %{a}', en: '📎 “%{g}” — %{a}' },
  previewAttachmentNone: { ru: 'без вложений', uz: 'ilovalarsiz', en: 'no attachments' },
  previewNoAttachments: { ru: 'Вложений не будет.', uz: 'Ilova yuborilmaydi.', en: 'There will be no attachments.' },
  previewWarnings: {
    ru: 'Предупреждения:\n%{w}',
    uz: 'Ogohlantirishlar:\n%{w}',
    en: 'Warnings:\n%{w}',
  },
  previewCut: {
    ru: '…[показаны первые %{n} символов; полностью уйдёт при публикации]',
    uz: '…[birinchi %{n} belgi ko‘rsatildi; to‘liq matn e’lon qilinadi]',
    en: '…[first %{n} characters shown; the full text will be published]',
  },
  previewNoPublish: {
    ru: 'Публикация не начнётся без нажатия «Опубликовать в группы».',
    uz: '«Guruhlarga e’lon qilish» bosilmaguncha e’lon boshlanmaydi.',
    en: 'Nothing is sent until you press “Publish to groups”.',
  },
  publishBtn: { ru: 'Опубликовать в группы', uz: 'Guruhlarga e’lon qilish', en: 'Publish to groups' },
  editBtn: { ru: 'Редактировать текст', uz: 'Matnni tahrirlash', en: 'Edit text' },
  addBtn: { ru: 'Добавить материалы', uz: 'Material qo‘shish', en: 'Add materials' },
  publishAlready: {
    ru: 'Этот черновик уже отправляется или отправлен — повторной отправки не будет.',
    uz: 'Bu qoralama allaqachon yuborilmoqda yoki yuborilgan — takror yuborilmaydi.',
    en: 'This draft is already being sent or was sent — there will be no duplicate send.',
  },
  publishing: {
    ru: 'Публикую в %{n} групп…',
    uz: '%{n} guruhga e’lon qilinmoqda…',
    en: 'Publishing to %{n} groups…',
  },

  publishResultTitle: {
    ru: 'Результат публикации:',
    uz: 'E’lon natijasi:',
    en: 'Publication result:',
  },
  pubSent: { ru: '✓ %{g} — отправлено', uz: '✓ %{g} — yuborildi', en: '✓ %{g} — sent' },
  pubFailed: { ru: '✗ %{g} — ошибка: %{r}', uz: '✗ %{g} — xato: %{r}', en: '✗ %{g} — failed: %{r}' },
  pubUncertain: {
    ru: '? %{g} — результат неизвестен: отправка оборвалась. Повторять автоматически нельзя.',
    uz: '? %{g} — natija noma’lum: yuborish uzildi. Avtomatik takrorlash mumkin emas.',
    en: '? %{g} — result unknown: the send was interrupted. It must not be retried automatically.',
  },
  /**
   * What the live test was missing: text and file have DIFFERENT outcomes, and one number
   * cannot describe both. `%{ok}` parts arrived, `%{bad}` did not — nothing is hidden.
   */
  pubPartial: {
    ru: '⚠ %{g} — доставлено %{ok}, не доставлено %{bad}',
    uz: '⚠ %{g} — %{ok} yetib bordi, %{bad} bormadi',
    en: '⚠ %{g} — %{ok} delivered, %{bad} not delivered',
  },
  pubCheckGroup: {
    ru: '? %{g} — статус доставки неизвестен; проверьте группу и не отправляйте повторно.',
    uz: '? %{g} — yetib borishi noma’lum; guruhni tekshiring va qayta yubormang.',
    en: '? %{g} — delivery status unknown; check the group and do not send it again.',
  },
  partText: { ru: 'текст', uz: 'matn', en: 'text' },
  partSent: { ru: 'отправлено', uz: 'yuborildi', en: 'sent' },
  partFailed: { ru: 'не отправлено: %{r}', uz: 'yuborilmadi: %{r}', en: 'not sent: %{r}' },
  partUnknown: {
    ru: 'статус неизвестен — проверьте группу',
    uz: 'holati noma’lum — guruhni tekshiring',
    en: 'delivery status unknown — check the group',
  },
  partLine: { ru: '   • %{l} — %{s}', uz: '   • %{l} — %{s}', en: '   • %{l} — %{s}' },
  reuploadHint: {
    ru: 'Файл не дошёл: пришлите его снова в этот чат или выберите другой в «📚 Materials».',
    uz: 'Fayl bormadi: shu chatga qayta yuboring yoki «📚 Materials» dan boshqasini tanlang.',
    en: 'The file did not arrive: send it here again, or pick another one under “📚 Materials”.',
  },
  publishedAll: {
    ru: 'Готово: задание опубликовано во все выбранные группы.',
    uz: 'Tayyor: vazifa barcha tanlangan guruhlarga e’lon qilindi.',
    en: 'Done: the homework was published to every selected group.',
  },
  publishedSome: {
    ru: 'Часть групп не получила задание. Повторить можно только явно неудачные отправки.',
    uz: 'Ba’zi guruhlar vazifani olmadi. Faqat aniq muvaffaqiyatsiz yuborishlarni takrorlash mumkin.',
    en: 'Some groups did not receive it. Only definite failures may be retried.',
  },
  publishedUnknown: {
    ru: 'Есть группы с неизвестным результатом. Проверьте их вручную; повторная кнопка отключена, чтобы не продублировать задание.',
    uz: 'Natijasi noma’lum guruhlar bor. Ularni qo‘lda tekshiring; takror tugmasi dublikat bo‘lmasligi uchun o‘chirilgan.',
    en: 'Some groups have an unknown result. Check them manually; retry is disabled to avoid a duplicate.',
  },
  retryBtn: { ru: 'Повторить неудачные', uz: 'Muvaffaqiyatsizlarni takrorlash', en: 'Retry failed' },
  retryNone: {
    ru: 'Повторять нечего: неудачных отправок нет.',
    uz: 'Takrorlash kerak emas: muvaffaqiyatsiz yuborish yo‘q.',
    en: 'Nothing to retry: there are no definite failures.',
  },
  retryAlready: {
    ru: 'Повтор уже выполняется или результат изменился.',
    uz: 'Takrorlash allaqachon ketmoqda yoki natija o‘zgargan.',
    en: 'A retry is already running or the result has changed.',
  },
  newDraftBtn: { ru: 'Новое задание', uz: 'Yangi vazifa', en: 'New homework' },
  groupRemovedDuringPublish: {
    ru: 'группа отключена',
    uz: 'guruh uzilgan',
    en: 'group disconnected',
  },
  sendFailed: {
    ru: 'Telegram отклонил отправку',
    uz: 'Telegram yuborishni rad etdi',
    en: 'Telegram rejected the send',
  },

  historyBtn: { ru: 'История отправок', uz: 'Yuborishlar tarixi', en: 'Send history' },
  historyTitle: {
    ru: 'Последние отправки:',
    uz: 'So‘nggi yuborishlar:',
    en: 'Recent sends:',
  },
  historyEmpty: {
    ru: 'Отправок пока не было.',
    uz: 'Hozircha yuborishlar yo‘q.',
    en: 'Nothing has been sent yet.',
  },
  historyLine: {
    ru: '%{at} — %{g} — %{s}',
    uz: '%{at} — %{g} — %{s}',
    en: '%{at} — %{g} — %{s}',
  },
  statusSent: { ru: 'отправлено', uz: 'yuborildi', en: 'sent' },
  statusFailed: { ru: 'ошибка', uz: 'xato', en: 'failed' },
  statusUncertain: { ru: 'результат неизвестен', uz: 'natija noma’lum', en: 'result unknown' },
  statusSending: { ru: 'отправляется', uz: 'yuborilmoqda', en: 'sending' },
  videoUnsupported: {
    ru: 'Видео, голосовые и стикеры пока не принимаются.',
    uz: 'Video, ovozli xabarlar va stikerlar hozircha qabul qilinmaydi.',
    en: 'Video, voice messages and stickers are not accepted yet.',
  },

  // ─── material library (part B) ──────────────────────────────────────────────

  libraryBtn: {
    ru: '📚 Библиотека материалов',
    uz: '📚 Materiallar kutubxonasi',
    en: '📚 Material library',
  },
  libraryTitle: {
    ru: 'Библиотека материалов.',
    uz: 'Materiallar kutubxonasi.',
    en: 'Material library.',
  },
  libraryHint: {
    ru: 'Учебник загружается один раз и прикладывается к заданиям снова. Его содержимое нигде не анализируется — бот знает только название.',
    uz: 'Darslik bir marta yuklanadi va vazifalarga qayta ilinadi. Mazmuni hech qayerda tahlil qilinmaydi — bot faqat nomini biladi.',
    en: 'A textbook is uploaded once and re-attached to homework later. Nothing reads its contents — the bot only knows the title.',
  },
  libraryCounts: {
    ru: 'Сохранено: %{n}. Групп подключено: %{g}.',
    uz: 'Saqlangan: %{n}. Guruhlar: %{g}.',
    en: 'Saved: %{n}. Connected groups: %{g}.',
  },
  libraryNoGroups: {
    ru: 'Сначала подключите группу: /homework → «Подключить группу» → в группе /bind КОД. Без группы материал привязать не к чему.',
    uz: 'Avval guruh ulang: /homework → «Guruh ulash» → guruhda /bind KOD. Guruh bo‘lmasa, materialni bog‘lab bo‘lmaydi.',
    en: 'Connect a group first: /homework → “Connect a group” → /bind CODE inside the group. Without a group a material has nothing to attach to.',
  },
  libraryAdd: { ru: '➕ Добавить материал', uz: '➕ Material qo‘shish', en: '➕ Add a material' },
  libraryPickForHw: {
    ru: '📝 Выбрать материал для ДЗ',
    uz: '📝 Uy vazifasi uchun material tanlash',
    en: '📝 Pick a material for homework',
  },
  libraryGroupMaterials: {
    ru: '📂 Материалы моих групп',
    uz: '📂 Guruhlarim materiallari',
    en: '📂 Materials of my groups',
  },
  libraryManage: { ru: '⚙️ Управление материалами', uz: '⚙️ Materiallarni boshqarish', en: '⚙️ Manage materials' },

  libAskGroups: {
    ru: 'В каких группах этот материал уместен? Отмеченные группы будут видеть его при создании задания.',
    uz: 'Bu material qaysi guruhlarda mos? Belgilangan guruhlar vazifa yaratishda uni ko‘radi.',
    en: 'Which groups is this material for? The checked groups will see it when a homework is created.',
  },
  libGroupContinue: { ru: '✅ Продолжить (%{n})', uz: '✅ Davom etish (%{n})', en: '✅ Continue (%{n})' },
  libAskFile: {
    ru: 'Пришлите файл одним сообщением: PDF, DOCX или фото учебника. До %{n} МБ.\nИли /cancel — отмена.',
    uz: 'Faylni bitta xabarda yuboring: PDF, DOCX yoki darslik fotosi. %{n} MB gacha.\nYoki /cancel — bekor qilish.',
    en: 'Send the file as one message: PDF, DOCX or a photo of the book. Up to %{n} MB.\nOr /cancel — cancel.',
  },
  libFileBad: {
    ru: 'Это не файл. Пришлите документ (PDF, DOCX) или фото — либо /cancel.',
    uz: 'Bu fayl emas. Hujjat (PDF, DOCX) yoki foto yuboring — yoki /cancel.',
    en: 'That is not a file. Send a document (PDF, DOCX) or a photo — or /cancel.',
  },
  libAskTitle: {
    ru: 'Как назвать материал? (до %{n} символов)\nПредложено: %{s}',
    uz: 'Materialni nomini yozing (%{n} belgigacha)\nTaklif etilgan: %{s}',
    en: 'What is this material called? (up to %{n} characters)\nSuggested: %{s}',
  },
  libTitleBad: {
    ru: 'Название должно быть 1–%{n} символов. Попробуйте ещё раз:',
    uz: 'Nom 1–%{n} belgi bo‘lsin. Qayta urinib ko‘ring:',
    en: 'The title must be 1–%{n} characters. Try again:',
  },
  libAskKind: { ru: 'Что это за материал?', uz: 'Bu qanday material?', en: 'What kind of material is it?' },
  kindBook: { ru: '📕 Книга', uz: '📕 Darslik', en: '📕 Book' },
  kindWorkbook: { ru: '📗 Рабочая тетрадь', uz: '📗 Ish daftari', en: '📗 Workbook' },
  kindOther: { ru: '📄 Другой материал', uz: '📄 Boshqa material', en: '📄 Other material' },
  libConfirmTitle: { ru: 'Проверьте и сохраните:', uz: 'Tekshiring va saqlang:', en: 'Check and save:' },
  libGroupsLocked: {
    ru: 'Группы зафиксированы: это задание пойдёт именно в них.',
    uz: 'Guruhlar belgilangan: bu vazifa aynan shularga yuboriladi.',
    en: 'The groups are fixed: this homework goes to exactly these ones.',
  },
  libConfirmLine: {
    ru: 'Название: %{t}\nТип: %{k}\nФайл: %{f}\nГруппы: %{g}',
    uz: 'Nom: %{t}\nTuri: %{k}\nFayl: %{f}\nGuruhlar: %{g}',
    en: 'Title: %{t}\nType: %{k}\nFile: %{f}\nGroups: %{g}',
  },
  libSave: { ru: '💾 Сохранить в библиотеку', uz: '💾 Kutubxonaga saqlash', en: '💾 Save to the library' },
  libSaved: {
    ru: 'Материал «%{t}» сохранён и доступен для повторного использования.\nГруппы: %{g}',
    uz: '«%{t}» materiali saqlandi va qayta ishlatishga tayyor.\nGuruhlar: %{g}',
    en: '“%{t}” is saved and ready to re-use.\nGroups: %{g}',
  },
  libUpdated: {
    ru: 'Этот файл уже был в библиотеке — обновили название, тип и группы, дубликат не создали.',
    uz: 'Bu fayl kutubxonada bo‘lgan — nom, tur va guruhlar yangilandi, dublikat yaratilmadi.',
    en: 'This file was already in the library — the title, type and groups were updated instead of creating a duplicate.',
  },
  libTooMany: {
    ru: 'В библиотеке уже %{n} материалов — это максимум. Удалите ненужное в «Управлении материалами».',
    uz: 'Kutubxonada %{n} material bor — bu eng ko‘pi. Keraksizlarni «Materiallarni boshqarish» da o‘chiring.',
    en: 'The library already holds %{n} materials — the maximum. Remove some in “Manage materials”.',
  },
  libCancelled: {
    ru: 'Добавление материала отменено. Библиотека не изменилась.',
    uz: 'Material qo‘shish bekor qilindi. Kutubxona o‘zgarmadi.',
    en: 'Adding the material was cancelled. The library did not change.',
  },
  libNotFound: {
    ru: 'Материал не найден или уже удалён.',
    uz: 'Material topilmadi yoki o‘chirilgan.',
    en: 'Material not found or already deleted.',
  },

  libGroupsTitle: { ru: 'Материалы по группам:', uz: 'Guruhlar bo‘yicha materiallar:', en: 'Materials by group:' },
  libGroupLine: { ru: '• %{g} — %{n}', uz: '• %{g} — %{n}', en: '• %{g} — %{n}' },
  libGroupMaterialsTitle: {
    ru: 'Материалы группы «%{g}»:',
    uz: '«%{g}» guruhi materiallari:',
    en: 'Materials of “%{g}”:',
  },
  libGroupEmpty: {
    ru: 'В этой группе сохранённых материалов пока нет.',
    uz: 'Bu guruhda hozircha saqlangan material yo‘q.',
    en: 'This group has no saved materials yet.',
  },

  libManageTitle: {
    ru: 'Управление материалами. Архивные не предлагаются новым заданиям, но остаются в библиотеке.',
    uz: 'Materiallarni boshqarish. Arxivdagi yangi vazifalarga taklif qilinmaydi, lekin kutubxonada qoladi.',
    en: 'Manage materials. Archived ones are not offered to new homework but stay in the library.',
  },
  libManageAll: { ru: 'Все группы', uz: 'Barcha guruhlar', en: 'All groups' },
  libManageEmpty: {
    ru: 'Библиотека пуста. Нажмите «Добавить материал».',
    uz: 'Kutubxona bo‘sh. «Material qo‘shish» ni bosing.',
    en: 'The library is empty. Press “Add a material”.',
  },
  libArchivedMark: { ru: 'архив', uz: 'arxiv', en: 'archived' },
  libStatusActive: {
    ru: 'предлагается новым заданиям',
    uz: 'yangi vazifalarga taklif qilinadi',
    en: 'offered to new homework',
  },
  libStatusArchived: {
    ru: 'убран из рекомендаций',
    uz: 'tavsiyalardan olingan',
    en: 'removed from recommendations',
  },
  libInfoLine: {
    ru: '%{t} · %{k}\n%{s}\nФайл: %{f}',
    uz: '%{t} · %{k}\n%{s}\nFayl: %{f}',
    en: '%{t} · %{k}\n%{s}\nFile: %{f}',
  },
  libInfoGroups: { ru: 'Группы: %{g}', uz: 'Guruhlar: %{g}', en: 'Groups: %{g}' },
  libLastUsed: { ru: 'Использовался: %{at}', uz: 'Ishlatilgan: %{at}', en: 'Last used: %{at}' },
  libNeverUsed: { ru: 'Ещё не использовался', uz: 'Hali ishlatilmagan', en: 'Not used yet' },
  libRename: { ru: '✏️ Переименовать', uz: '✏️ Nomini o‘zgartirish', en: '✏️ Rename' },
  libRenameAsk: {
    ru: 'Новое название (до %{n} символов). /cancel — отмена.',
    uz: 'Yangi nom (%{n} belgigacha). /cancel — bekor qilish.',
    en: 'New title (up to %{n} characters). /cancel — cancel.',
  },
  libRenamed: {
    ru: 'Название изменено на «%{t}». Прошлые публикации остались под прежним названием.',
    uz: 'Nom «%{t}» ga o‘zgartildi. Oldin yuborilganlar eski nomi bilan tarixda qoldi.',
    en: 'Renamed to “%{t}”. Publications sent earlier keep their old title in history.',
  },
  libUseElsewhere: {
    ru: '➕ Использовать в другой группе',
    uz: '➕ Boshqa guruhda ishlatish',
    en: '➕ Use in another group',
  },
  libNoOtherGroups: {
    ru: 'Других подключённых групп нет.',
    uz: 'Boshqa ulangan guruh yo‘q.',
    en: 'There are no other connected groups.',
  },
  libLinkConfirm: {
    ru: 'Начать рекомендовать «%{t}» в группе «%{g}»?',
    uz: '«%{t}» materialini «%{g}» guruhida tavsiya qilib boshlasinmi?',
    en: 'Start recommending “%{t}” in “%{g}”?',
  },
  libLinkYes: { ru: 'Да, подключить', uz: 'Ha, ulash', en: 'Yes, add it' },
  libLinked: {
    ru: 'Материал «%{t}» теперь доступен и в группе «%{g}».',
    uz: '«%{t}» endi «%{g}» guruhida ham mavjud.',
    en: '“%{t}” is now available in “%{g}” too.',
  },
  libArchive: { ru: '🗄 Убрать из рекомендаций', uz: '🗄 Tavsiyalardan olish', en: '🗄 Remove from recommendations' },
  libRestore: { ru: '↩️ Вернуть в рекомендации', uz: '↩️ Tavsiyalarga qaytarish', en: '↩️ Put back in recommendations' },
  libArchiveConfirm: {
    ru: 'Убрать «%{t}» из рекомендаций? Файл останется в библиотеке, история прежних отправок не изменится.',
    uz: '«%{t}» tavsiyalardan olinsinmi? Fayl kutubxonada qoladi, eski yuborishlar tarixi o‘zgarmaydi.',
    en: 'Remove “%{t}” from recommendations? The file stays in the library and the send history does not change.',
  },
  libArchiveYes: { ru: 'Да, убрать', uz: 'Ha, olish', en: 'Yes, remove it' },
  libArchived: {
    ru: '«%{t}» убран из рекомендаций. Новые задания его не предложат; история прежних публикаций сохранена.',
    uz: '«%{t}» tavsiyalardan olindi. Yangi vazifalar uni taklif qilmaydi; eski yuborishlar tarixi saqlandi.',
    en: '“%{t}” is out of recommendations. New homework will not offer it; the publication history is kept.',
  },
  libRestored: {
    ru: '«%{t}» снова предлагается при создании заданий.',
    uz: '«%{t}» vazifa yaratishda yana taklif qilinadi.',
    en: '“%{t}” is offered again when creating homework.',
  },
  libDelete: { ru: '🗑 Удалить из библиотеки', uz: '🗑 Kutubxonadan o‘chirish', en: '🗑 Delete from the library' },
  libDeleteConfirm: {
    ru: 'Удалить «%{t}» из библиотеки? Отправленные ранее задания останутся в историях групп и в Telegram.',
    uz: '«%{t}» kutubxonadan o‘chirilsinmi? Avval yuborilgan vazifalar guruh tarixlarida va Telegramda qoladi.',
    en: 'Delete “%{t}” from the library? Homework already published stays in the group histories and in Telegram.',
  },
  libDeleteYes: { ru: 'Да, удалить', uz: 'Ha, o‘chirish', en: 'Yes, delete' },
  libDeleted: {
    ru: 'Материал удалён из библиотеки. История прежних публикаций не изменилась.',
    uz: 'Material kutubxonadan o‘chirildi. Eski yuborishlar tarixi o‘zgarmadi.',
    en: 'The material was deleted from the library. The history of past sends did not change.',
  },

  // ─── library inside /homework ───────────────────────────────────────────────

  chooseMaterialsTitle: {
    ru: 'Группы выбраны (%{n}). Возьмите сохранённый материал или продолжите без него.',
    uz: 'Guruhlar tanlandi (%{n}). Saqlangan materialni oling yoki uningcha davom eting.',
    en: 'Groups chosen (%{n}). Use a saved material or continue without one.',
  },
  chooseSaved: {
    ru: '📚 Использовать сохранённый материал (%{n})',
    uz: '📚 Saqlangan materialni ishlatish (%{n})',
    en: '📚 Use a saved material (%{n})',
  },
  uploadNewMaterial: {
    ru: '➕ Загрузить новый материал',
    uz: '➕ Yangi material yuklash',
    en: '➕ Upload a new material',
  },
  continueWithout: { ru: 'Продолжить без материала', uz: 'Materialsiz davom etish', en: 'Continue without a material' },
  noMaterialsForGroups: {
    ru: 'Для выбранных групп сохранённых материалов нет.',
    uz: 'Tanlangan guruhlar uchun saqlangan material yo‘q.',
    en: 'No saved material exists for the selected groups.',
  },
  pickerTitle: {
    ru: 'Сохранённые материалы (отмечено: %{n}):',
    uz: 'Saqlangan materiallar (belgilangan: %{n}):',
    en: 'Saved materials (%{n} selected):',
  },
  pickerHint: {
    ru: 'Здесь только материалы, подключенные ко всем выбранным группам — в другой группе они не появятся. Сначала идут недавно использованные.',
    uz: 'Bu yerda faqat barcha tanlangan guruhlarga bog‘langan materiallar — boshqa guruhda ular ko‘rinmaydi. Avval yaqinda ishlatilganlari.',
    en: 'Only materials attached to every selected group are listed — they never appear for another group. Recently used ones come first.',
  },
  pickerContinue: { ru: '✅ Продолжить (%{n})', uz: '✅ Davom etish (%{n})', en: '✅ Continue (%{n})' },
  materialsBtn: { ru: '📚 Материалы', uz: '📚 Materiallar', en: '📚 Materials' },
  materialsLimit: {
    ru: 'К заданию можно приложить не больше %{n} материалов.',
    uz: 'Vazifaga %{n} tadan ko‘p material ilib bo‘lmaydi.',
    en: 'A homework can attach at most %{n} materials.',
  },
  materialsUnlinked: {
    ru: 'Группы изменились, и эти материалы убраны из черновика: %{m}. Выберите заново или подключите их к новым группам в библиотеке.',
    uz: 'Guruhlar o‘zgardi, bu materiallar qoralamadan olindi: %{m}. Qayta tanlang yoki kutubxonada yangi guruhlarga ulang.',
    en: 'The groups changed, so these materials were dropped from the draft: %{m}. Pick again, or attach them to the new groups in the library.',
  },
  materialAttached: {
    ru: 'Материал «%{t}» добавлен в библиотеку и выбран для этого задания.',
    uz: '«%{t}» kutubxonaga qo‘shildi va shu vazifa uchun tanlandi.',
    en: '“%{t}” was added to the library and selected for this homework.',
  },
  fileUnavailable: {
    ru: 'Файл «%{m}» больше недоступен для повторной отправки — Telegram его не принимает. Ничего не опубликовано; материал убран из черновика. Загрузите файл заново в «📚 Материалы» и выберите его снова.',
    uz: '«%{m}» fayli qayta yuborishga yaroqsiz — Telegram uni qabul qilmaydi. Hech narsa e’lon qilinmadi; material qoralamadan olindi. Faylni «📚 Materiallar» da qayta yuklab, yana tanlang.',
    en: 'The file “%{m}” can no longer be re-sent — Telegram refuses it. Nothing was published and it was dropped from the draft. Upload it again under “📚 Materials” and select it again.',
  },
  instructionPrompt: {
    ru: 'Что нужно выполнить? Например: Unit 2, Exercises 1–5 или Pages 24–27, Unit 2.\nМатериалы: %{m}\nПришлите текст одним сообщением, /cancel — отмена.',
    uz: 'Nima bajariladi? Masalan: Unit 2, Exercises 1–5 yoki Pages 24–27, Unit 2.\nMateriallar: %{m}\nMatnni bitta xabarda yuboring, /cancel — bekor qilish.',
    en: 'What exactly should they do? For example: Unit 2, Exercises 1–5 or Pages 24–27, Unit 2.\nMaterials: %{m}\nSend it as one message, /cancel — cancel.',
  },
  instructionTooLong: {
    ru: 'Инструкция длиннее %{n} символов. Сократите её.',
    uz: 'Ko‘rsatma %{n} belgidan uzun. Qisqartiring.',
    en: 'The instruction is longer than %{n} characters. Shorten it.',
  },
  instructionSaved: {
    ru: 'Инструкция сохранена. Теперь можно добавить материалы или нажать «Готово — оформить задание».',
    uz: 'Ko‘rsatma saqlandi. Endi material qo‘shish yoki «Tayyor — vazifani rasmiylashtirish» ni bosish mumkin.',
    en: 'Instruction saved. Now add materials or press “Done — format the homework”.',
  },
  skipInstruction: { ru: 'Пропустить инструкцию', uz: 'Ko‘rsatmani o‘tkazib yuborish', en: 'Skip the instruction' },
  noInstruction: { ru: 'без инструкции', uz: 'ko‘rsatmasiz', en: 'without an instruction' },
  toHomeworkBtn: { ru: '➡️ К заданию', uz: '➡️ Vazifaga o‘tish', en: '➡️ Go to the homework' },

  // ─── the local formatter's own wording ──────────────────────────────────────

  hwHeading: { ru: 'ДОМАШНЕЕ ЗАДАНИЕ', uz: 'UY VAZIFASI', en: 'HOMEWORK' },
  materialLabel: { ru: 'Материал: %{t}', uz: 'Material: %{t}', en: 'Material: %{t}' },
  materialsLabel: { ru: 'Материалы:', uz: 'Materiallar:', en: 'Materials:' },
  taskLabel: { ru: 'Задание:', uz: 'Vazifa:', en: 'Task:' },
} as const satisfies Record<string, Loc>;

export type HKey = keyof typeof H;

export function h(key: HKey, lang: HwLang, vars: Record<string, string | number> = {}): string {
  let s: string = H[key][lang] ?? H[key].en;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`%{${k}}`, String(v));
  return s;
}

export function kindLabel(kind: HwItemKind, lang: HwLang): string {
  const key: HKey = kind === 'link' ? 'kindLink' : kind === 'photo' ? 'kindPhoto'
    : kind === 'document' ? 'kindDocument' : 'kindText';
  return h(key, lang);
}

/** The label for a library material type — a book, a workbook, anything else. */
export function materialKindLabel(kind: HwMaterialKind, lang: HwLang): string {
  const key: HKey = kind === 'book' ? 'kindBook' : kind === 'workbook' ? 'kindWorkbook' : 'kindOther';
  return h(key, lang);
}
