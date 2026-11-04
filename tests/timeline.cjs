const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const report = JSON.parse(fs.readFileSync('test-results/desktop-report.json', 'utf8'));
const data = path.resolve('.test-data', `timeline-ui-${Date.now()}`);
fs.mkdirSync(data, { recursive: true });
fs.cpSync(report.storagePath, path.join(data, 'library'), { recursive: true });
const libraryFile = path.join(data, 'library/library.json');
const fixture = JSON.parse(fs.readFileSync(libraryFile, 'utf8'));
// Intentionally retain the old year-only schema, with reversed import ordering.
for (const paper of fixture.papers) { delete paper.publicationDate; paper.importedAt = `${4050 - paper.year}-01-01T00:00:00.000Z`; }
fs.writeFileSync(libraryFile, JSON.stringify(fixture));
const env = { ...process.env, PAPER_TIMELINE_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;

async function checkCardLayout(page) {
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.timeline-paper[data-publication-date]:not([data-publication-date=""])')];
    return [...document.querySelectorAll('.map-branch line')].every((line, i) => {
      const card = cards[i];
      const frame = card.querySelector('.timeline-paper-body');
      const edge = Number(line.getAttribute('y2'));
      const frameTop = card.offsetTop + frame.offsetTop;
      return Math.abs(Number(line.getAttribute('x2')) - card.offsetLeft - frame.offsetLeft - frame.offsetWidth / 2) <= 1
        && Math.min(Math.abs(edge - frameTop), Math.abs(edge - frameTop - frame.offsetHeight)) <= 1;
    });
  });
  const cards = await page.locator('.timeline-paper').evaluateAll(els => els.map(el => {
    const title = el.querySelector('h3'), frame = el.querySelector('.timeline-paper-body');
    return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight,
      frameW: frame.offsetWidth, frameH: frame.offsetHeight,
      sceneW: el.closest('.map-scene').offsetWidth, sceneH: el.closest('.map-scene').offsetHeight,
      titleFits: title.scrollHeight <= title.clientHeight + 1 && title.scrollWidth <= title.clientWidth + 1,
    };
  }));
  for (const a of cards) {
    assert.ok(a.titleFits, 'the complete title should fit without clipping');
    assert.ok(a.frameW >= 220 && a.frameW <= 360 && a.frameH > 0, 'the visible frame should retain its natural title dimensions');
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= a.sceneW + 1 && a.y + a.h <= a.sceneH + 1, 'scene should contain every card');
    for (const b of cards) if (a !== b) assert.equal(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y, false, 'cards must not overlap');
  }
}

async function readCanvasGeometry(page) {
  return page.evaluate(async () => {
    // Let both React and ResizeObserver commit any layout caused by this gesture.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = el => {
      const bounds = el.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    };
    const viewport = document.querySelector('.map-viewport');
    return {
      frames: [...document.querySelectorAll('.timeline-paper')].map(card => ({
        id: card.dataset.paperId, ...rect(card.querySelector('.timeline-paper-body')),
      })),
      axes: [...document.querySelectorAll('.map-axis')].map(rect),
      zoom: document.querySelector('.zoom-value').textContent,
      scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop,
    };
  });
}

function assertCanvasUnchanged(actual, expected, stage) {
  assert.equal(actual.zoom, expected.zoom, `${stage}: zoom must stay fixed`);
  assert.equal(actual.scrollLeft, expected.scrollLeft, `${stage}: horizontal scrolling must stay fixed`);
  assert.equal(actual.scrollTop, expected.scrollTop, `${stage}: vertical scrolling must stay fixed`);
  for (const key of ['frames', 'axes']) {
    assert.equal(actual[key].length, expected[key].length, `${stage}: ${key} count should not change`);
    actual[key].forEach((rect, index) => {
      if (key === 'frames') assert.equal(rect.id, expected[key][index].id);
      for (const coordinate of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(rect[coordinate] - expected[key][index][coordinate]) <= 0.05,
          `${stage}: ${key}[${index}].${coordinate} moved from ${expected[key][index][coordinate]} to ${rect[coordinate]}`);
      }
    });
  }
}

(async () => {
  let app = await electron.launch({ executablePath: require('electron'), args: ['.'], env, cwd: root });
  try {
    let page = await app.firstWindow();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 6);
    assert.match(await page.locator('.paper-row').first().innerText(), /2024/);
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    assert.equal(await page.locator('.timeline-paper').count(), 6);
    assert.equal(await page.locator('.detail-panel').count(), 0);
    const years = await page.locator('.timeline-paper').evaluateAll(els => els.map(el => el.getAttribute('data-publication-date')));
    assert.deepEqual(years, ['2024', '2025', '2025', '2025', '2025', '2026']);
    assert.equal(await page.locator('.map-axis').count(), 1);
    assert.equal(await page.locator('.map-branch').count(), 6);
    await page.getByLabel('适应画布', { exact: true }).click();
    await page.screenshot({ path: 'test-results/desktop-mindmap.png' });
    const boxes = await page.locator('.timeline-paper').evaluateAll(els => els.map(el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      assert.equal(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y, false);
    }
    const paperOnCanvas = title => page.locator('.timeline-paper').filter({ hasText: title });
    await checkCardLayout(page);
    const cardSize = locator => locator.locator('.timeline-paper-body').evaluate(el => ({ w: el.offsetWidth, h: el.offsetHeight }));
    const shortSize = await cardSize(paperOnCanvas('Driving on Registers'));
    const longSize = await cardSize(paperOnCanvas('Learning Based MPC'));
    assert.ok(shortSize.w < longSize.w && shortSize.h < longSize.h, 'short titles should use smaller cards');
    await page.screenshot({ path: 'test-results/desktop-adaptive-cards.png' });

    let taggedCard = paperOnCanvas('Driving on Registers');
    const addTag = async (text, colorName) => {
      await taggedCard.locator('h3').click({ button: 'right' });
      await page.getByRole('menuitem', { name: '添加标签', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '添加标签', exact: true });
      await dialog.getByLabel('标签文字', { exact: true }).fill(text);
      await dialog.getByRole('button', { name: `${colorName}背景`, exact: true }).click();
      await dialog.getByRole('button', { name: '保存标签', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await taggedCard.locator('.paper-tag').filter({ hasText: text }).waitFor();
    };
    const readTags = () => taggedCard.locator('.paper-tag').evaluateAll(tags => tags.map(tag => ({
      id: tag.getAttribute('data-tag-id'), text: tag.textContent, color: getComputedStyle(tag).backgroundColor,
    })));
    assert.equal(await taggedCard.locator('.paper-tag').count(), 0);
    const originalPaper = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers.find(p => p.title === 'Driving on Registers');
    await addTag('单一网络', '绿色');
    await checkCardLayout(page);
    assert.deepEqual(await cardSize(taggedCard), shortSize, 'adding a tag must retain the title-sized paper frame');
    assert.ok(await taggedCard.evaluate(el => el.offsetHeight > el.querySelector('.timeline-paper-body').offsetHeight),
      'the outer layout should reserve space for labels around the frame');
    await addTag('视觉-动作', '青色');
    await checkCardLayout(page);
    const addedTags = await readTags();
    assert.deepEqual(addedTags.map(({ text, color }) => ({ text, color })), [
      { text: '单一网络', color: 'rgb(191, 228, 196)' }, { text: '视觉-动作', color: 'rgb(189, 228, 230)' },
    ]);
    assert.ok(addedTags.every(tag => /^[a-f0-9-]{36}$/.test(tag.id)));
    assert.notEqual(addedTags[0].id, addedTags[1].id);
    await page.getByLabel('适应画布', { exact: true }).click();
    await page.screenshot({ path: 'test-results/desktop-timeline-tags.png' });
    await page.reload();
    await taggedCard.locator(`.paper-tag[data-tag-id="${addedTags[1].id}"]`).waitFor();
    assert.deepEqual(await readTags(), addedTags, 'tag IDs, text and background colors should survive reload');
    await checkCardLayout(page);
    let firstTag = taggedCard.locator(`.paper-tag[data-tag-id="${addedTags[0].id}"]`);
    await firstTag.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '编辑标签', exact: true }).click();
    const tagDialog = page.getByRole('dialog', { name: '编辑标签', exact: true });
    assert.equal(await tagDialog.getByLabel('标签文字', { exact: true }).inputValue(), '单一网络');
    assert.equal(await tagDialog.getByRole('button', { name: '绿色背景', exact: true }).getAttribute('aria-pressed'), 'true');
    await tagDialog.getByLabel('标签文字', { exact: true }).fill('端到端网络');
    await tagDialog.getByRole('button', { name: '青色背景', exact: true }).click();
    await tagDialog.getByRole('button', { name: '保存标签', exact: true }).click();
    await tagDialog.waitFor({ state: 'hidden' });
    await firstTag.filter({ hasText: '端到端网络' }).waitFor();
    assert.deepEqual(await readTags(), [
      { id: addedTags[0].id, text: '端到端网络', color: 'rgb(189, 228, 230)' }, addedTags[1],
    ], 'editing a tag should preserve its ID and other tags');
    await checkCardLayout(page);
    const persistedPaper = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers.find(p => p.id === originalPaper.id);
    assert.deepEqual(persistedPaper.tags, [
      { id: addedTags[0].id, text: '端到端网络', color: '#BDE4E6' },
      { id: addedTags[1].id, text: '视觉-动作', color: '#BDE4E6' },
    ]);
    assert.equal(persistedPaper.status, originalPaper.status); assert.equal(persistedPaper.source, originalPaper.source);

    // Filters aggregate tag names across papers, independently of each tag's ID and color.
    const secondTaggedPaper = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers.find(p => p.id !== originalPaper.id);
    assert.ok(secondTaggedPaper, 'the filter fixture needs another paper');
    const sharedTag = await page.evaluate(id => window.paperApi.addTag(id, '视觉-动作', '#F5E5AD'), secondTaggedPaper.id);
    assert.notEqual(sharedTag.id, addedTags[1].id);
    const tagFilterTrigger = page.getByRole('button', { name: '时间线标签筛选', exact: true });
    const tagFilterDialog = page.getByRole('dialog', { name: '按标签筛选', exact: true });
    const waitForCanvasPapers = async ids => {
      await page.waitForFunction(expected => {
        const actual = [...document.querySelectorAll('.timeline-paper')].map(card => card.dataset.paperId).sort();
        return JSON.stringify(actual) === JSON.stringify([...expected].sort());
      }, ids);
    };
    const selectTimelineTag = async (text, count) => {
      await tagFilterTrigger.click();
      await tagFilterDialog.getByRole('button', { name: /^全部论文，/ }).click();
      if (text !== '全部论文') await tagFilterDialog.getByRole('checkbox', { name: `${text}，${count} 篇论文`, exact: true }).click();
      await tagFilterDialog.getByRole('button', { name: '完成', exact: true }).click();
      await tagFilterDialog.waitFor({ state: 'hidden' });
    };
    await tagFilterTrigger.click();
    assert.equal(await tagFilterDialog.locator('[data-tag-filter-option="视觉-动作"]').count(), 1,
      'same-name tags with different IDs and colors should have only one filter option');
    await tagFilterDialog.getByRole('checkbox', { name: '视觉-动作，2 篇论文', exact: true }).click();
    await tagFilterDialog.getByRole('button', { name: '完成', exact: true }).click();
    await tagFilterDialog.waitFor({ state: 'hidden' });
    await waitForCanvasPapers([originalPaper.id, secondTaggedPaper.id]);
    assert.equal(await page.locator('.detail-panel').count(), 0, 'choosing a filter should not open paper details');
    await page.screenshot({ path: 'test-results/desktop-timeline-tag-filter.png' });
    await selectTimelineTag('端到端网络', 1);
    await waitForCanvasPapers([originalPaper.id]);
    assert.equal(await page.locator('.detail-panel').count(), 0);

    // Search within a long tag list must keep the recovery option available.
    await tagFilterTrigger.click();
    const tagSearch = tagFilterDialog.getByRole('searchbox', { name: '搜索标签', exact: true });
    await tagSearch.fill('no-such-tag-abcdef');
    await tagFilterDialog.getByText('没有找到匹配的标签', { exact: true }).waitFor();
    assert.equal(await tagFilterDialog.locator('[data-tag-filter-option]').count(), 1);
    assert.equal(await tagFilterDialog.getByRole('button', { name: '全部论文，6 篇论文', exact: true }).isVisible(), true);
    await tagSearch.fill('');
    await tagFilterDialog.getByRole('button', { name: '全部论文，6 篇论文', exact: true }).click();
    await tagFilterDialog.getByRole('checkbox', { name: '视觉-动作，2 篇论文', exact: true }).click();
    await tagFilterDialog.getByRole('button', { name: '完成', exact: true }).click();
    await tagFilterDialog.waitFor({ state: 'hidden' });
    await waitForCanvasPapers([originalPaper.id, secondTaggedPaper.id]);

    // Multi-selection stays open while the canvas relayouts; pointer and keyboard
    // changes to the sliding switch must preserve every selected checkbox.
    await tagFilterTrigger.click();
    const visionChoice = tagFilterDialog.getByRole('checkbox', { name: '视觉-动作，2 篇论文', exact: true });
    const networkChoice = tagFilterDialog.getByRole('checkbox', { name: '端到端网络，1 篇论文', exact: true });
    const matchSwitch = tagFilterDialog.getByRole('switch', { name: '交集与并集', exact: true });
    await networkChoice.click();
    await waitForCanvasPapers([originalPaper.id]);
    assert.equal(await matchSwitch.getAttribute('aria-checked'), 'false');
    assert.equal(await tagFilterDialog.isVisible(), true);
    await tagFilterDialog.getByText('已选 2 个 · 显示 1 篇', { exact: true }).waitFor();
    for (const union of [true, false]) {
      const box = await matchSwitch.boundingBox();
      await page.mouse.move(box.x + box.width * (union ? 0.25 : 0.75), box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * (union ? 0.75 : 0.25), box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await waitForCanvasPapers(union ? [originalPaper.id, secondTaggedPaper.id] : [originalPaper.id]);
      assert.equal(await matchSwitch.getAttribute('aria-checked'), String(union));
      assert.equal(await visionChoice.getAttribute('aria-checked'), 'true');
      assert.equal(await networkChoice.getAttribute('aria-checked'), 'true');
      assert.equal(await tagFilterDialog.isVisible(), true);
    }
    await matchSwitch.focus(); await page.keyboard.press('ArrowRight');
    await waitForCanvasPapers([originalPaper.id, secondTaggedPaper.id]);
    await page.keyboard.press('ArrowLeft');
    await waitForCanvasPapers([originalPaper.id]);
    await tagSearch.fill('视觉');
    await visionChoice.click();
    await waitForCanvasPapers([originalPaper.id]);
    await tagSearch.fill('');
    assert.equal(await networkChoice.getAttribute('aria-checked'), 'true', 'searching must retain hidden selections');
    await networkChoice.click();
    await waitForCanvasPapers(fixture.papers.map(paper => paper.id));
    await visionChoice.click();
    await tagFilterDialog.getByRole('button', { name: '完成', exact: true }).click();
    await waitForCanvasPapers([originalPaper.id, secondTaggedPaper.id]);

    await page.getByRole('button', { name: '列表', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 6);
    assert.equal(await page.locator('.paper-row').count(), 6, 'the timeline tag filter must not restrict the list view');
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    await waitForCanvasPapers([originalPaper.id, secondTaggedPaper.id]);
    assert.match(await tagFilterTrigger.getAttribute('title'), /视觉-动作/);

    // A global query can leave no matching papers; the axis filter must remain usable.
    await page.getByLabel('搜索文献').fill('no-such-paper-for-tag-filter');
    await page.getByRole('heading', { name: '没有符合所选标签的论文', exact: true }).waitFor();
    assert.equal(await page.locator('.timeline-paper').count(), 0);
    assert.equal(await tagFilterTrigger.isVisible(), true);
    await selectTimelineTag('全部论文', 0);
    await page.getByRole('heading', { name: '没有匹配的文献', exact: true }).waitFor();
    await page.getByLabel('清空搜索').click();
    await waitForCanvasPapers(fixture.papers.map(paper => paper.id));

    // Keep undated tagged papers reachable even when there is no dated axis to draw.
    await selectTimelineTag('视觉-动作', 2);
    await page.evaluate(paper => window.paperApi.saveMetadata(paper.id, { ...paper, year: null, publicationDate: '' }), secondTaggedPaper);
    await page.locator(`.map-undated .timeline-paper[data-paper-id="${secondTaggedPaper.id}"]`).waitFor();
    await waitForCanvasPapers([originalPaper.id, secondTaggedPaper.id]);
    await page.getByLabel('搜索文献').fill(secondTaggedPaper.title);
    await waitForCanvasPapers([secondTaggedPaper.id]);
    assert.equal(await page.locator('.map-axis').count(), 0);
    assert.equal(await page.locator('.map-undated .timeline-paper').count(), 1);
    assert.equal(await tagFilterTrigger.isVisible(), true);
    await selectTimelineTag('全部论文', 1);
    await waitForCanvasPapers([secondTaggedPaper.id]);
    await page.getByLabel('清空搜索').click();
    await waitForCanvasPapers(fixture.papers.map(paper => paper.id));
    await page.evaluate(paper => window.paperApi.saveMetadata(paper.id, paper), secondTaggedPaper);
    await page.waitForFunction(() => document.querySelectorAll('.map-branch').length === 6);
    await page.evaluate(({ paperId, tagId }) => window.paperApi.deleteTag(paperId, tagId), {
      paperId: secondTaggedPaper.id, tagId: sharedTag.id,
    });
    await tagFilterTrigger.click();
    await tagFilterDialog.getByRole('checkbox', { name: '视觉-动作，1 篇论文', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await tagFilterDialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '时间线标签筛选');
    assert.equal(await tagFilterTrigger.evaluate(el => el === document.activeElement), true);
    const restoredFilterPaper = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers.find(p => p.id === secondTaggedPaper.id);
    assert.equal(restoredFilterPaper.publicationDate, secondTaggedPaper.publicationDate);
    assert.deepEqual(restoredFilterPaper.tags || [], secondTaggedPaper.tags || []);
    await checkCardLayout(page);

    // New lanes start with only a filter control, and own their filters/position.
    const originalTrack = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).timelines[0];
    const firstLane = page.locator(`.timeline-lane[data-timeline-id="${originalTrack.id}"]`);
    const firstLanePapers = await firstLane.locator('.timeline-paper').count();
    const originalPaperData = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers;
    await page.getByRole('button', { name: '新增时间线', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.timeline-lane').length === 2);
    const secondLane = page.getByRole('region', { name: '时间线 2', exact: true });
    assert.equal(await secondLane.locator('.timeline-paper').count(), 0);
    assert.equal(await secondLane.locator('.map-axis').count(), 0);
    await secondLane.getByRole('button', { name: '时间线标签筛选', exact: true }).click();
    await tagFilterDialog.getByRole('checkbox', { name: '端到端网络，1 篇论文', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.timeline-lane')[1].querySelectorAll('.timeline-paper').length === 1);
    await tagFilterDialog.getByRole('button', { name: '完成', exact: true }).click();
    assert.equal(await firstLane.locator('.timeline-paper').count(), firstLanePapers);
    assert.equal(await secondLane.locator('.timeline-paper').getAttribute('data-paper-id'), originalPaper.id);
    await page.getByLabel('适应画布', { exact: true }).click();
    const laneGeometry = async () => firstLane.locator('.timeline-paper-body').evaluateAll(frames => frames.map(frame => {
      const r = frame.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
    await readCanvasGeometry(page);
    const stationary = await laneGeometry();
    const secondControl = secondLane.getByRole('button', { name: '时间线标签筛选', exact: true });
    const secondId = await secondLane.getAttribute('data-timeline-id');
    const savedSecond = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).timelines.find(track => track.id === secondId);
    const controlBox = await secondControl.boundingBox();
    await page.mouse.move(controlBox.x + controlBox.width / 2, controlBox.y + controlBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(controlBox.x + controlBox.width / 2 + 130, controlBox.y + controlBox.height / 2 - 40, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(async ({ id, x }) => (await window.paperApi.getLibrary()).timelines.find(track => track.id === id).position.x !== x,
      { id: secondId, x: savedSecond.position.x });
    assert.equal(await tagFilterDialog.isVisible(), false, 'dragging a filter box must not open the picker');
    const afterMoving = await laneGeometry();
    afterMoving.forEach((rect, index) => Object.keys(rect).forEach(key => {
      assert.ok(Math.abs(rect[key] - stationary[index][key]) <= 0.1, 'moving one lane must leave the other lane still');
    }));
    const afterTracks = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).timelines;
    assert.deepEqual(afterTracks.find(track => track.id === originalTrack.id), originalTrack);
    await secondLane.getByRole('button', { name: '删除时间线 2', exact: true }).click();
    await secondLane.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.timeline-paper').count(), firstLanePapers);
    assert.deepEqual(JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers, originalPaperData);

    // Exercise pointer capture at a non-default zoom using actual mouse gestures.
    // Tags attach to the visible frame, not to the larger outer layout bounds.
    const checkTagContact = async (tag, expectedSide) => {
      const geometry = await tag.evaluate(el => {
        const frame = el.closest('.timeline-paper').querySelector('.timeline-paper-body');
        const badge = el.getBoundingClientRect(), rect = frame.getBoundingClientRect();
        const scale = rect.width / frame.offsetWidth;
        const side = el.getAttribute('data-tag-side');
        const gap = { top: rect.top - badge.bottom, right: badge.left - rect.right,
          bottom: badge.top - rect.bottom, left: rect.left - badge.right }[side] / scale;
        const alongOverlap = side === 'top' || side === 'bottom'
          ? Math.min(badge.right, rect.right) - Math.max(badge.left, rect.left)
          : Math.min(badge.bottom, rect.bottom) - Math.max(badge.top, rect.top);
        return { side, gap, alongOverlap };
      });
      if (expectedSide) assert.equal(geometry.side, expectedSide);
      assert.ok(Math.abs(geometry.gap) <= 1.01, `tag must touch the ${geometry.side} border within one CSS pixel`);
      assert.ok(geometry.alongOverlap > 0, 'tag should overlap the length of the attached border');
    };
    await page.getByLabel('恢复百分之百').click();
    await page.getByLabel('缩小', { exact: true }).click();
    const dragZoom = await page.getByLabel('恢复百分之百').innerText();
    assert.equal(dragZoom, '90%');
    await checkTagContact(firstTag, 'bottom');
    for (const [side, offset] of [['top', 0.3], ['right', 0.6], ['left', 0.25], ['bottom', 0.15]]) {
      await taggedCard.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
      const badge = await firstTag.boundingBox();
      const frame = await taggedCard.locator('.timeline-paper-body').boundingBox();
      const scale = await taggedCard.locator('.timeline-paper-body').evaluate(el => el.getBoundingClientRect().width / el.offsetWidth);
      const horizontal = side === 'top' || side === 'bottom';
      const target = horizontal
        ? { x: frame.x + badge.width / 2 + (frame.width - badge.width) * offset,
          y: side === 'top' ? frame.y - badge.height / 2 + scale : frame.y + frame.height + badge.height / 2 - scale }
        : { x: side === 'left' ? frame.x - badge.width / 2 + scale : frame.x + frame.width + badge.width / 2 - scale,
          y: frame.y + badge.height / 2 + (frame.height - badge.height) * offset };
      const start = { x: badge.x + badge.width / 2, y: badge.y + badge.height / 2 };
      await page.mouse.move(start.x, start.y);
      const fixedGeometry = await readCanvasGeometry(page);
      await page.mouse.down();
      assertCanvasUnchanged(await readCanvasGeometry(page), fixedGeometry, `${side} pointer down`);
      for (let step = 1; step <= 8; step++) {
        await page.mouse.move(start.x + (target.x - start.x) * step / 8, start.y + (target.y - start.y) * step / 8);
        await checkTagContact(firstTag);
        assertCanvasUnchanged(await readCanvasGeometry(page), fixedGeometry, `${side} drag step ${step}`);
      }
      await checkTagContact(firstTag, side);
      await page.mouse.up();
      await page.waitForFunction(id => !document.querySelector(`.timeline-paper[data-paper-id="${id}"]`).classList.contains('tag-dragging'), originalPaper.id);
      await checkCardLayout(page);
      await checkTagContact(firstTag, side);
      assertCanvasUnchanged(await readCanvasGeometry(page), fixedGeometry, `${side} saved`);
      assert.equal(await page.getByLabel('恢复百分之百').innerText(), dragZoom, 'dragging tags must preserve the chosen zoom');
      assert.equal(await page.locator('.detail-panel').count(), 0, 'drag release must not open paper details');
      const movedPaper = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers.find(p => p.id === originalPaper.id);
      const movedTag = movedPaper.tags.find(tag => tag.id === addedTags[0].id);
      assert.equal(movedTag.position.side, side);
      assert.ok(Math.abs(movedTag.position.offset - offset) < 0.02, 'drag position should be saved as a relative offset');
      assert.deepEqual(movedPaper.tags[1], persistedPaper.tags[1], 'moving a tag must preserve other tags');
      assert.equal(movedPaper.status, originalPaper.status); assert.equal(movedPaper.source, originalPaper.source);
    }
    const tagsBeforeRestart = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers.find(p => p.id === originalPaper.id).tags;
    const geometryBeforeRestart = await readCanvasGeometry(page);
    await page.screenshot({ path: 'test-results/desktop-timeline-tag-drag.png' });
    await app.close();
    app = await electron.launch({ executablePath: require('electron'), args: ['.'], env, cwd: root });
    page = await app.firstWindow();
    page.on('pageerror', e => errors.push(e.message));
    taggedCard = paperOnCanvas('Driving on Registers');
    firstTag = taggedCard.locator(`.paper-tag[data-tag-id="${addedTags[0].id}"]`);
    await firstTag.waitFor();
    await checkCardLayout(page);
    // Zoom starts at 100% after launch; compare only after restoring the same viewport.
    await page.getByLabel('恢复百分之百').click();
    await page.getByLabel('缩小', { exact: true }).click();
    await readCanvasGeometry(page);
    await page.locator('.map-viewport').evaluate((el, geometry) => {
      el.scrollLeft = geometry.scrollLeft; el.scrollTop = geometry.scrollTop;
    }, geometryBeforeRestart);
    assertCanvasUnchanged(await readCanvasGeometry(page), geometryBeforeRestart, 'restored saved positions');
    await checkTagContact(firstTag, 'bottom');
    assert.deepEqual(JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers.find(p => p.id === originalPaper.id).tags, tagsBeforeRestart,
      'tag IDs, text, colors and positions should survive a complete app restart');
    const restartedOffset = await firstTag.evaluate(el => {
      const frame = el.closest('.timeline-paper').querySelector('.timeline-paper-body');
      return (el.offsetLeft - frame.offsetLeft) / (frame.offsetWidth - el.offsetWidth);
    });
    assert.ok(Math.abs(restartedOffset - tagsBeforeRestart[0].position.offset) < 0.02, 'restarted UI must restore the saved relative position');
    assert.equal(await page.locator('.detail-panel').count(), 0);
    for (const tag of addedTags) {
      const badge = taggedCard.locator(`.paper-tag[data-tag-id="${tag.id}"]`);
      await badge.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '删除标签', exact: true }).click();
      const deleteDialog = page.getByRole('dialog', { name: '是否确定删除标签？', exact: true });
      await deleteDialog.getByRole('button', { name: '确认删除', exact: true }).click();
      await deleteDialog.waitFor({ state: 'hidden' });
      await badge.waitFor({ state: 'detached' });
      await page.getByRole('menu', { name: '论文标签操作', exact: true }).waitFor({ state: 'hidden' });
      await checkCardLayout(page);
    }
    assert.equal(await taggedCard.locator('.paper-tag').count(), 0);
    assert.deepEqual(await cardSize(taggedCard), shortSize, 'deleting all tags should restore the original card size');
    assert.deepEqual(JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers.find(p => p.id === originalPaper.id).tags, []);

    assert.equal(await page.locator('.map-axis-date').first().innerText(), '2024');
    await paperOnCanvas('Driving on Registers').click();
    assert.equal(await page.locator('.detail-title').innerText(), 'Driving on Registers');
    await page.getByRole('button', { name: '列表', exact: true }).click();
    assert.match(await page.locator('.paper-row.selected').innerText(), /Driving on Registers/);
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    await page.getByLabel('恢复百分之百').click();
    await page.getByLabel('放大', { exact: true }).click();
    assert.equal(await page.getByLabel('恢复百分之百').innerText(), '110%');
    await page.getByLabel('放大', { exact: true }).click();
    const canvas = page.getByLabel('论文时间线画布', { exact: true });
    await canvas.evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
    const view = await canvas.boundingBox();
    await page.mouse.move(view.x + 450, view.y + 20);
    await page.mouse.down({ button: 'middle' }); await page.mouse.move(view.x + 180, view.y + 20, { steps: 8 }); await page.mouse.up({ button: 'middle' });
    assert.ok(await canvas.evaluate(el => el.scrollLeft > 150));
    assert.equal(await page.locator('.detail-panel').count(), 0);
    const zoomBefore = parseInt(await page.getByLabel('恢复百分之百').innerText());
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
    await page.waitForFunction(before => parseInt(document.querySelector('.zoom-value').textContent) > before, zoomBefore);
    await page.getByLabel('缩小', { exact: true }).click();
    await page.getByLabel('适应画布', { exact: true }).click();

    await page.getByLabel('搜索文献').fill('Learning Based MPC');
    assert.equal(await page.locator('.timeline-paper').count(), 1);
    await page.locator('.timeline-paper').click();
    assert.match(await page.locator('.detail-title').innerText(), /Learning Based MPC/);
    await page.getByLabel('搜索文献').fill('no-such-paper-abcdef');
    await page.getByRole('heading', { name: '没有匹配的文献' }).waitFor();
    assert.equal(await page.locator('.map-axis').count(), 0);
    await page.getByLabel('清空搜索').click();
    await page.getByLabel('文献筛选').selectOption('review');
    assert.equal(await page.locator('.timeline-paper').count(), 0);
    await page.getByLabel('文献筛选').selectOption('all');
    await page.locator('.timeline-paper').filter({ hasText: 'Driving on Registers' }).click();

    await page.getByLabel('更多操作').click();
    await page.getByLabel('编辑元数据', { exact: true }).click();
    const expandedTitle = 'Driving on Registers: ' + '面向自动驾驶的多模态场景理解与轨迹规划'.repeat(12);
    await page.getByLabel('标题', { exact: true }).fill(expandedTitle);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await checkCardLayout(page);
    const expandedSize = await cardSize(paperOnCanvas('Driving on Registers'));
    assert.ok(expandedSize.w > shortSize.w && expandedSize.h > longSize.h, 'title edits should resize and relayout cards');
    await page.getByLabel('更多操作').click();
    await page.getByLabel('编辑元数据', { exact: true }).click();
    await page.getByLabel('标题', { exact: true }).fill('Driving on Registers');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await checkCardLayout(page);
    assert.deepEqual(await cardSize(paperOnCanvas('Driving on Registers')), shortSize, 'shortening a title should shrink its card again');

    const editDate = async value => {
      await page.getByLabel('更多操作').click();
      await page.getByLabel('编辑元数据', { exact: true }).click();
      await page.getByLabel('发表日期', { exact: true }).fill(value);
      await page.getByRole('button', { name: '保存', exact: true }).click();
    };
    await editDate('2023-02-29');
    await page.locator('.form-error').filter({ hasText: '发表日期格式不正确' }).waitFor();
    await page.getByLabel('发表日期', { exact: true }).fill('2023-02-03');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('.timeline-paper')?.getAttribute('data-publication-date') === '2023-02-03');
    assert.match(await page.locator('.publication').innerText(), /2023 年 2 月 3 日/);
    assert.equal(await page.locator('.timeline-paper.selected').getAttribute('data-publication-date'), '2023-02-03');
    let saved = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers.find(p => p.title === 'Driving on Registers');
    assert.equal(saved.publicationDate, '2023-02-03'); assert.equal(saved.year, 2023);
    await page.reload();
    await page.locator('.timeline-paper').filter({ hasText: 'Driving on Registers' }).click();
    assert.equal(await page.getByRole('button', { name: '时间线', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('.publication').innerText(), /2023 年 2 月 3 日/);

    await editDate('2025-04');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.map-axis-date.selected').innerText(), '2025.04');
    await editDate('');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.locator('.map-undated .timeline-paper').waitFor();
    await checkCardLayout(page);
    assert.equal(await page.locator('.map-branch').count(), 5);
    saved = JSON.parse(fs.readFileSync(libraryFile, 'utf8')).papers.find(p => p.title === 'Driving on Registers');
    assert.equal(saved.publicationDate, ''); assert.equal(saved.year, null);
    await page.getByLabel('搜索文献').fill('Driving on Registers');
    assert.equal(await page.locator('.map-axis').count(), 0);
    assert.equal(await page.locator('.map-undated .timeline-paper').count(), 1);
    await page.screenshot({ path: 'test-results/desktop-mindmap-undated.png' });
    await page.getByLabel('清空搜索').click();
    await editDate('2026-01-08');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '关闭通知' }).click();
    await page.getByLabel('收起详情').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 700));
    await page.getByLabel('适应画布', { exact: true }).click();
    await page.screenshot({ path: 'test-results/desktop-mindmap-compact.png' });
    await checkCardLayout(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const last = page.locator('.timeline-paper').last();
    await last.scrollIntoViewIfNeeded(); await last.click();
    assert.equal(await page.locator('.detail-title').innerText(), await last.locator('h3').innerText());
    await page.screenshot({ path: 'test-results/desktop-mindmap-detail.png' });
    await page.getByLabel('收起详情').click();
    await canvas.focus(); await page.keyboard.press('=');
    assert.equal(await page.locator('.detail-panel').count(), 0);
    const keyboardZoom = parseInt(await page.getByLabel('恢复百分之百').innerText());
    await page.keyboard.press('-');
    assert.ok(parseInt(await page.getByLabel('恢复百分之百').innerText()) < keyboardZoom);
    await page.keyboard.press('0');
    await page.getByRole('button', { name: '时间线标签筛选', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '按标签筛选', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '按标签筛选', exact: true }).waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '时间线标签筛选');
    await canvas.focus();
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await page.getByLabel('收起详情').waitFor();
    assert.deepEqual(errors, []);
  } finally { await app.close(); }

  const empty = await electron.launch({ executablePath: require('electron'), args: ['.'], env: { ...env, PAPER_TIMELINE_DATA: data + '-empty' }, cwd: root });
  try {
    const page = await empty.firstWindow();
    await page.getByRole('heading', { name: '导入你的第一篇论文' }).waitFor();
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    await page.getByRole('heading', { name: '导入你的第一篇论文' }).waitFor();
    assert.equal(await page.locator('.timeline-paper').count(), 0);
  } finally { await empty.close(); }
  const denseData = data + '-dense';
  fs.mkdirSync(path.join(denseData, 'library'), { recursive: true });
  const densePapers = Array.from({ length: 50 }, (_, i) => ({ ...fixture.papers[i % fixture.papers.length],
    id: require('node:crypto').createHash('sha256').update(`layout-fixture-${i}`).digest('hex'),
    title: `布局测试 ${String(i + 1).padStart(2, '0')} · ${i % 7 === 0 ? '无空格长标题'.repeat(40) : fixture.papers[i % fixture.papers.length].title}`,
    year: 2025, publicationDate: '2025-04-02', status: 'matched',
  }));
  fs.writeFileSync(path.join(denseData, 'library/library.json'), JSON.stringify({ version: 1, papers: densePapers }));
  const dense = await electron.launch({ executablePath: require('electron'), args: ['.'], env: { ...env, PAPER_TIMELINE_DATA: denseData }, cwd: root });
  try {
    const page = await dense.firstWindow();
    await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 50);
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    await page.getByLabel('适应画布', { exact: true }).click();
    await page.waitForFunction(() => parseInt(document.querySelector('.zoom-value').textContent) < 20);
    assert.equal(await page.locator('.timeline-paper').count(), 50);
    await checkCardLayout(page);
    const allVisible = await page.locator('.map-viewport').evaluate(el => {
      const view = el.getBoundingClientRect();
      return [...el.querySelectorAll('.timeline-paper')].every(card => { const r = card.getBoundingClientRect(); return r.left >= view.left && r.right <= view.right && r.top >= view.top && r.bottom <= view.bottom; });
    });
    assert.equal(allVisible, true, 'fit should include the entire large library');
    await page.getByLabel('恢复百分之百').click();
    await page.locator('.timeline-paper').last().click();
    assert.match(await page.locator('.detail-title').innerText(), /布局测试 50/);
  } finally { await dense.close(); }
  console.log('PASS: horizontal map, separate cards/branches, date order, colored tag add/edit/four-side dragging with fixed paper frames/axis/zoom/scroll/delete/restart persistence, multi-tag intersection/union via pointer and keyboard, tag filtering by shared names/search/empty results/list independence/undated recovery, pan, zoom, fit, keyboard access, detail panel, search/filter, editing/persistence, unknown dates, saved view, compact layout and empty library.');
})().catch(error => { console.error(error); process.exitCode = 1; });
