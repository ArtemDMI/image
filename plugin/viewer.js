// A classic script shares the page global. Names like status already exist on window.
(() => {
    const token = new URLSearchParams(location.search).get('token') || '';
    const placeholder = document.querySelector('#placeholder');
    const pic = document.querySelector('#pic');
    const statusLine = document.querySelector('#status');
    const button = document.querySelector('#go');

    let busy = false;
    let watch = 0;
    let stream = null;
    let streamRetry = 0;

    function showStatus(message, isError) {
        statusLine.textContent = message;
        statusLine.classList.toggle('is-error', Boolean(isError));
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
