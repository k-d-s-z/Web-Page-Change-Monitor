function initDragAndDrop(container) {
  container.addEventListener('pointerdown', onCardPointerDown);
  container.addEventListener('click', (e) => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

function getCardOrder() {
  return Array.from(document.querySelectorAll('#sites-container .site-card')).map((c) => c.dataset.id);
}

async function onCardKeyDown(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

  const onHandle = e.target.classList.contains('drag-handle');
  if (!onHandle && !e.altKey) return;

  const card = e.currentTarget;
  if (card.classList.contains('confirming') || drag) return;

  e.preventDefault();
  if (e.key === 'ArrowUp') {
    const prev = card.previousElementSibling;
    if (!prev) return;
    card.after(prev);
  } else {
    const next = card.nextElementSibling;
    if (!next) return;
    card.before(next);
  }

  await persistOrder(getCardOrder());
}

function onCardPointerDown(e) {
  if (e.button !== 0 || drag) return;

  const handle = e.target.closest('.drag-handle');
  if (!handle) return;

  const card = handle.closest('.site-card');
  if (!card || card.classList.contains('confirming')) return;

  drag = {
    card,
    startX: e.clientX,
    startY: e.clientY,
    lastY: e.clientY,
    active: false,
    rafId: null,
    orderBefore: getCardOrder()
  };

  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragCancel);
}

function activateDrag() {
  if (!drag) return;
  drag.active = true;
  drag.card.classList.add('dragging');
  document.body.classList.add('is-dragging');
  drag.rafId = requestAnimationFrame(dragFrame);
}

function onDragMove(e) {
  if (!drag) return;
  drag.lastY = e.clientY;

  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
    activateDrag();
  }

  e.preventDefault();
  moveDraggedCard(e.clientY);
}

function dragFrame() {
  if (!drag || !drag.active) return;

  const footer = document.querySelector('.list-footer');
  const bottomEdge = footer ? footer.getBoundingClientRect().top : window.innerHeight;

  if (drag.lastY < AUTOSCROLL_ZONE_PX) {
    window.scrollBy(0, -AUTOSCROLL_SPEED_PX);
  } else if (drag.lastY > bottomEdge - AUTOSCROLL_ZONE_PX) {
    window.scrollBy(0, AUTOSCROLL_SPEED_PX);
  }
  moveDraggedCard(drag.lastY);
  drag.rafId = requestAnimationFrame(dragFrame);
}

function moveDraggedCard(clientY) {
  const container = document.getElementById('sites-container');
  const others = Array.from(container.querySelectorAll('.site-card:not(.dragging)'));

  let next = null;
  for (const el of others) {
    const box = el.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) {
      next = el;
      break;
    }
  }

  if (drag.card.nextElementSibling !== next) {
    container.insertBefore(drag.card, next);
  }
}

function stopDragTracking() {
  const d = drag;
  drag = null;
  if (!d) return null;

  if (d.rafId) cancelAnimationFrame(d.rafId);
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragCancel);
  return d;
}

function finishActiveDrag(d) {
  d.card.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 100);
}

async function onDragEnd() {
  const d = stopDragTracking();
  if (!d || !d.active) return;

  finishActiveDrag(d);

  const newOrder = getCardOrder();
  if (newOrder.join('|') !== d.orderBefore.join('|')) {
    await persistOrder(newOrder);
  }
}

function onDragCancel() {
  const d = stopDragTracking();
  if (!d || !d.active) return;

  finishActiveDrag(d);
  renderSites();
}