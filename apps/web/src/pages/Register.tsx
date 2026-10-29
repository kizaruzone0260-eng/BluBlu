import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../App';

/**
 * «Как попасть в класс» — страница вместо прежней регистрации по коду (2026-10-27).
 *
 * Что отсюда ушло и почему. Раньше это был двухшаговый вход «код класса → имя и пароль»:
 * первый шаг проверял восьмизначный код, не расходуя его, второй создавал аккаунт. Приём по коду
 * выведен из продукта: учителю нужно было уметь прочитать восемь символов вслух или переслать их
 * по слову, а ученику — угадать, где этот код взять. Осталось два способа, и оба видны здесь.
 *
 * Страница сохранена как адрес, а не удалена, ровно по той же причине, по которой серверные
 * маршруты отвечают 410, а не 404: закладочка `/register` живёт в браузерах школы. Человек,
 * который пришёл сюда по старой памяти, обязан получить внятное предложение «что делать», а не
 * пустой экран или red-строку «что-то не работает».
 *
 * Формы здесь нет намеренно. Публичной регистрации без приглашения больше не существует: новый
 * ученик либо открывает одноразовую ссылку учителя, либо получает аккаунт, который учитель создал
 * сам. Второй путь — экран класса (`ClassDetail.tsx`), и он доступен только учителю этого класса.
 */
export default function Register() {
  const { t } = useTranslation();
  // Вошедшему страница тоже доступна (ссылки из Home и Classes): «Войти» ему не нужно,
  // а ссылка вела бы на перенаправление домой (аудит 2026-10-28, пункт 11).
  const { me } = useAuth();

  return (
    <div className="card" style={{ maxWidth: 460, margin: '40px auto' }} data-testid="register-explainer">
      <h1>{t('register.title')}</h1>
      <p className="muted" style={{ fontSize: '.9rem' }}>{t('register.lead')}</p>
      <ol className="register-ways" data-testid="register-ways">
        <li>
          <strong>{t('register.wayLink')}</strong>
          <p className="muted" style={{ fontSize: '.86rem', margin: '4px 0 0' }}>{t('register.wayLinkHint')}</p>
        </li>
        <li>
          <strong>{t('register.wayTeacher')}</strong>
          <p className="muted" style={{ fontSize: '.86rem', margin: '4px 0 0' }}>{t('register.wayTeacherHint')}</p>
        </li>
      </ol>
      <p className="muted" data-testid="register-code-retired" style={{ fontSize: '.86rem' }}>
        {t('register.codeRetired')}
      </p>
      <p>
        {!me && <Link to="/login" data-testid="register-login">{t('common.login')}</Link>}
      </p>
      <p className="muted">
        <Link to="/privacy">{t('legalLinks.privacy')}</Link>
        {' · '}
        <Link to="/terms">{t('legalLinks.terms')}</Link>
      </p>
    </div>
  );
}
