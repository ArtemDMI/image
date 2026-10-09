// A classic script shares the page global. `top` and `status` already exist on window, so those names would stop the file from parsing.
(() => {
const MIN_W = 280;
        const MIN_H = 360;
        const MAX_W = 2400;
        const MAX_H = 1800;
        const STORAGE_KEY = 'location-map-frame';
        const token = new URLSearchParams(location.search).get('token') || '';

        const win = document.querySelector('#win');
        const bar = document.querySelector('#bar');
        const scaleInput = document.querySelector('#scale');
        const scaleLabel = document.querySelector('#scaleLabel');
        const placeholder = document.querySelector('#placeholder');
        const pic = document.querySelector('#pic');
        const status = document.querySelector('#status');
        const button = document.querySelector('#go');

        let left = 24;
        let top = 24;
        let baseWidth = 760;
        let baseHeight = 620;
        let scale = 1;
        let busy = false;
        let watch = 0;

        function visualWidth() {
            return baseWidth * scale;
        }

        function visualHeight() {
            return baseHeight * scale;
        }

        function limitScale(value) {
            let next = Math.min(2, Math.max(0.5, value));
            next = Math.round(next * 20) / 20;
            if (baseWidth * next > MAX_W) next = MAX_W / baseWidth;
            if (baseHeight * next > MAX_H) next = Math.min(next, MAX_H / baseHeight);
            if (baseWidth * next < MIN_W) next = Math.max(next, MIN_W / baseWidth);
            if (baseHeight * next < MIN_H) next = Math.max(next, MIN_H / baseHeight);
            return next;
        }

        function clampPosition() {
            const minLeft = Math.min(0, window.innerWidth - visualWidth());
            const maxLeft = Math.max(minLeft, window.innerWidth - 80);
            left = Math.min(Math.max(minLeft, left), maxLeft);
            top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - 48));
        }

        function apply() {
            win.style.left = `${left}px`;
            win.style.top = `${top}px`;
            win.style.width = `${visualWidth()}px`;
            win.style.height = `${visualHeight()}px`;
            scaleLabel.textContent = `${Math.round(scale * 100)}%`;
            // Writing the thumb while it is being dragged drops the pointer in Chrome.
            if (document.activeElement !== scaleInput) {
                scaleInput.value = String(scale);
            }
        }

        function persist() {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    left, top, baseWidth, baseHeight, scale,
                }));
            } catch {
                // A blocked storage must not stop dragging.
            }
        }

        function restore() {
            try {
                const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
                if (!saved) return false;
                const numbers = [saved.left, saved.top, saved.baseWidth, saved.baseHeight, saved.scale];
                if (!numbers.every(Number.isFinite)) return false;
                if (saved.baseWidth < 40 || saved.baseHeight < 40) return false;
                left = saved.left;
                top = saved.top;
                baseWidth = saved.baseWidth;
                baseHeight = saved.baseHeight;
                scale = limitScale(saved.scale);
                return true;
            } catch {
                return false;
            }
        }

        function placeInitial() {
            baseWidth = Math.max(MIN_W, Math.min(760, window.innerWidth - 24));
            baseHeight = Math.max(MIN_H, Math.min(620, window.innerHeight - 24));
            scale = 1;
            left = Math.max(8, (window.innerWidth - baseWidth) / 2);
            top = Math.max(8, (window.innerHeight - baseHeight) / 2);
        }

        function setScale(next) {
            const cx = left + visualWidth() / 2;
            const cy = top + visualHeight() / 2;
            scale = limitScale(next);
            left = cx - visualWidth() / 2;
            top = cy - visualHeight() / 2;
            clampPosition();
            apply();
            persist();
        }

        function resizeBy(edge, dx, dy) {
            if (edge.includes('e')) {
                const next = Math.min(MAX_W, Math.max(MIN_W, visualWidth() + dx));
                baseWidth = next / scale;
            }
            if (edge.includes('s')) {
                const next = Math.min(MAX_H, Math.max(MIN_H, visualHeight() + dy));
                baseHeight = next / scale;
            }
            if (edge.includes('w')) {
                const old = visualWidth();
                const next = Math.min(MAX_W, Math.max(MIN_W, old - dx));
                left += old - next;
                baseWidth = next / scale;
            }
            if (edge.includes('n')) {
                const old = visualHeight();
                const next = Math.min(MAX_H, Math.max(MIN_H, old - dy));
                top += old - next;
                baseHeight = next / scale;
            }
            clampPosition();
            apply();
        }

        function showStatus(message, isError) {
            status.textContent = message;
            status.classList.toggle('is-error', Boolean(isError));
        }

        function setBusy(next) {
            busy = next;
            button.disabled = next;
            if (!next) window.clearTimeout(watch);
        }

        function armWatch() {
            window.clearTimeout(watch);
            // One model call is capped at 120s. Silence longer than that means the chat tab stopped.
            watch = window.setTimeout(() => {
                setBusy(false);
                showStatus('Нет ответа от SillyTavern. Проверьте, что чат открыт.', true);
            }, 150000);
        }

        if (!restore()) placeInitial();
        clampPosition();
        apply();

        let drag = null;
        let resize = null;

        function trackPointer(event) {
            return event.clientX !== 0 || event.clientY !== 0;
        }

        bar.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            if (event.target.closest('input, button, label')) return;
            try {
                bar.setPointerCapture(event.pointerId);
            } catch {
                // A drag that is not a pointer stream has nothing to capture.
            }
            drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left, top };
        });
        bar.addEventListener('pointermove', event => {
            if (!drag || drag.id !== event.pointerId || !trackPointer(event)) return;
            left = drag.left + (event.clientX - drag.x);
            top = drag.top + (event.clientY - drag.y);
            clampPosition();
            apply();
        });
        bar.addEventListener('pointerup', event => {
            if (!drag || drag.id !== event.pointerId) return;
            drag = null;
            persist();
        });
        // Some drag gestures report dragover instead of pointermove. Keep both.
        bar.addEventListener('dragstart', event => {
            if (event.target.closest('input, button, label')) {
                event.preventDefault();
                return;
            }
            drag = { id: null, x: event.clientX, y: event.clientY, left, top };
            event.dataTransfer?.setData('text/plain', 'window');
            event.dataTransfer?.setDragImage(document.createElement('canvas'), 0, 0);
        });
        window.addEventListener('dragover', event => {
            if (!drag || drag.id !== null || !trackPointer(event)) return;
            event.preventDefault();
            left = drag.left + (event.clientX - drag.x);
            top = drag.top + (event.clientY - drag.y);
            clampPosition();
            apply();
        });
        window.addEventListener('dragend', () => {
            if (!drag || drag.id !== null) return;
            drag = null;
            persist();
        });

        for (const handle of document.querySelectorAll('.handle')) {
            handle.addEventListener('pointerdown', event => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                try {
                    handle.setPointerCapture(event.pointerId);
                } catch {
                    // A drag that is not a pointer stream has nothing to capture.
                }
                resize = {
                    id: event.pointerId,
                    edge: handle.dataset.edge,
                    x: event.clientX,
                    y: event.clientY,
                };
            });
            handle.addEventListener('pointermove', event => {
                if (!resize || resize.id !== event.pointerId || !trackPointer(event)) return;
                const dx = event.clientX - resize.x;
                const dy = event.clientY - resize.y;
                resize.x = event.clientX;
                resize.y = event.clientY;
                resizeBy(resize.edge, dx, dy);
            });
            handle.addEventListener('pointerup', event => {
                if (!resize || resize.id !== event.pointerId) return;
                resize = null;
                persist();
            });
            handle.addEventListener('dragstart', event => {
                event.stopPropagation();
                resize = { id: null, edge: handle.dataset.edge, x: event.clientX, y: event.clientY };
                event.dataTransfer?.setData('text/plain', 'resize');
                event.dataTransfer?.setDragImage(document.createElement('canvas'), 0, 0);
            });
        }
        window.addEventListener('dragover', event => {
            if (!resize || resize.id !== null || !trackPointer(event)) return;
            event.preventDefault();
            const dx = event.clientX - resize.x;
            const dy = event.clientY - resize.y;
            resize.x = event.clientX;
            resize.y = event.clientY;
            resizeBy(resize.edge, dx, dy);
        });
        window.addEventListener('dragend', () => {
            if (!resize || resize.id !== null) return;
            resize = null;
            persist();
        });

        scaleInput.addEventListener('input', () => {
            setScale(Number(scaleInput.value));
        });
        win.addEventListener('wheel', event => {
            if (event.target.closest('input')) return;
            event.preventDefault();
            const step = Math.abs(event.deltaY) >= 40
                ? (event.deltaY > 0 ? -0.05 : 0.05)
                : (-event.deltaY / 500);
            if (Math.abs(step) < 0.005) return;
            setScale(scale + step);
        }, { passive: false });
        window.addEventListener('resize', () => {
            clampPosition();
            apply();
        });

        let stream = null;
        let streamRetry = 0;

        function connect() {
            if (!token) {
                showStatus('В адресе нет token.', true);
                button.disabled = true;
                return;
            }
            stream?.close();
            const source = new EventSource(`/events?token=${encodeURIComponent(token)}&role=view`);
            stream = source;
            source.addEventListener('status', event => {
                const data = JSON.parse(event.data);
                const failed = data.phase === 'error';
                showStatus(data.message || '', failed);
                if (data.phase === 'ready' || failed) setBusy(false);
                else {
                    setBusy(true);
                    armWatch();
                }
            });
            source.addEventListener('image', event => {
                const data = JSON.parse(event.data);
                pic.src = `/image?token=${encodeURIComponent(token)}&v=${data.jobId}`;
            });
            source.onerror = () => {
                source.close();
                if (stream !== source) return;
                stream = null;
                window.clearTimeout(streamRetry);
                streamRetry = window.setTimeout(connect, 2000);
            };
        }

        pic.addEventListener('load', () => {
            pic.hidden = false;
            placeholder.hidden = true;
        });
        pic.addEventListener('error', () => {
            if (!pic.getAttribute('src')) return;
            showStatus('Картинка не загрузилась', true);
            setBusy(false);
        });

        button.addEventListener('click', async () => {
            if (busy || !token) return;
            setBusy(true);
            showStatus('Генерация…', false);
            armWatch();
            try {
                const response = await fetch(`/generate?token=${encodeURIComponent(token)}`, { method: 'POST' });
                if (response.ok) return;
                const data = await response.json().catch(() => ({}));
                showStatus(data.error || 'Не удалось начать генерацию', true);
                setBusy(false);
            } catch {
                showStatus('Нет связи с окном', true);
                setBusy(false);
            }
        });

        connect();
})();
