/**
 * Помощники нижней панели управления (задача 2026-10-10).
 *
 * Почему это отдельный модуль, а не копипаста в четырёх спеках: панель живёт в автоскрытии
 * (полноэкранный режим и собственный показ экрана убирают её, движение мыши возвращает).
 * Playwright проверяет видимость ЭЛЕМЕНТА и не шевелит мышь, пока элемент скрыт, — «кликнуть
 * скрытую кнопку» без пробуждения невозможно в принципе. Поэтому каждый клик по панели идёт
 * через `barClick`, который делает ровно то, что делает человек: двигает мышь и ждёт панель.
 *
 * Это навигация, а не утверждение: сила самих проверок от этого не меняется.
 */
import { expect, type Page } from '@playwright/test';

export async function wakeBar(page: Page) {
  await page.mouse.move(8, 8);
  await page.mouse.move(400, 400);
  await expect(page.getByTestId('lesson-bar')).toBeVisible({ timeout: 10_000 });
}

/** клик по кнопке нижней панели с пробуждением; force не используется — видимость настоящая */
export async function barClick(page: Page, testid: string) {
  await wakeBar(page);
  await page.getByTestId(testid).click();
}

/**
 * Открыть вкладку правой панели. Идемпотентно: кнопка панели ПЕРЕКЛЮЧАЕТ свою вкладку, поэтому
 * повторный вызов не должен закрывать то, что уже открыто, а переключение с другой вкладки
 * делается ссылкой самой панели.
 */
export async function openTab(page: Page, tab: 'people' | 'comments') {
  const panel = page.getByTestId(tab === 'people' ? 'peers-panel' : 'comments-panel');
  if (await panel.isVisible().catch(() => false)) return;
  const link = page.getByTestId(`tab-${tab}`);
  if (await link.isVisible().catch(() => false)) {
    await link.click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    return;
  }
  // на телефоне участников на полосе нет (пять кнопок) — там это вход через «Ещё»
  const barBtn = tab === 'people' ? 'participants-toggle' : 'comments-open';
  if (await page.getByTestId(barBtn).isVisible().catch(() => false)) await barClick(page, barBtn);
  else { await openMore(page); await page.getByTestId('more-participants').click(); }
  await expect(panel).toBeVisible({ timeout: 10_000 });
}

/** открыть меню «Ещё» */
export async function openMore(page: Page) {
  await barClick(page, 'more-btn');
  await expect(page.getByTestId('more-menu')).toBeVisible({ timeout: 10_000 });
}

/** сколько кнопок панели реально видно — ровно то, что видит человек на этом разрешении */
export async function visibleButtons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('.lesson-bar [data-testid]'))) {
      const node = el as HTMLElement;
      // считаем только управляющие элементы: счётчик непрочитанных — это span, и он не кнопка
      const isControl = node.tagName === 'BUTTON' || node.tagName === 'A';
      if (isControl && !node.closest('.bar-menu') && node.offsetParent !== null && node.getBoundingClientRect().width > 0) {
        out.push(node.dataset.testid as string);
      }
    }
    return out;
  });
}
