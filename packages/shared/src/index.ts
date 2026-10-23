export * from './constants.js';
export * from './schemas.js';
export * from './content.js';
export * from './media.js';
export * from './inkView.js';
export * from './stageModel.js';
export * from './chatReply.js';
export * from './localePick.js';
export * from './dateTimeField.js';
// часть E: чистая «сцена → страница» живёт в общем экспорте, а сборка .docx — только по
// отдельному под-путю (@klass/shared/boardDocxBuild), чтобы docx не попал в начальный чанк
export * from './boardWord.js';
export * from './lessonKeep.js';
export * from './caps.js';
export * from './editorDraft.js';
export * from './authErrors.js';
export * from './browserContext.js';
// часть A: правила панели стилей доски — чистые, чтобы проверяться без браузера
export * from './boardStylesPanel.js';
// часть C: правила окна показа экрана поверх других программ — те же четыре ответа, что и в вебе
export * from './screenPip.js';
export * from './inviteLinks.js';
export * from './joinToken.js';
export * from './emailCode.js';
export * from './emailTemplates.js';
