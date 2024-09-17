/* global browser */

import '../ext/webext.js';


const idleWorkers = [];
const workers = new Set();


async function peaksProcessor(athlete, activities, options) {
    let worker;
    while (!worker) {
        if (idleWorkers.length) {
            console.info("Claiming idle web worker");
            worker = idleWorkers.shift();
        } else if (workers.size >= navigator.hardwareConcurrency * 2) {
            // Cheapout on sleep lock..
            await new Promise(r => setTimeout(r, 200));
            continue;
        } else {
            console.info("Creating new web worker:", workers.size + 1);
            worker = new Worker('/src/bg/hist/peaks-worker.mjs', {type: 'module'});
            workers.add(worker);
        }
    }
    if (worker.idleTimeout) {
        clearTimeout(worker.idleTimeout);
    }
    const ch = new MessageChannel();
    const ourPort = ch.port1;
    const theirPort = ch.port2;
    const p = new Promise((resolve, reject) => {
        const onError = ev => reject(new Error(ev.message));
        worker.addEventListener('error', onError, {once: true});
        ourPort.addEventListener('message', ev => {
            worker.removeEventListener('error', onError);
            if (ev.data.success) {
                resolve(ev.data.value);
            } else {
                console.error("peaks processor worker error:", ev.data.error);
                const e = new Error(ev.data.error.message);
                e.stack = ev.data.error.stack;
                reject(e);
            }
        });
    });
    ourPort.start();
    worker.postMessage({athlete, activities, options, port: theirPort}, [theirPort]);
    try {
        const ret = await p;
        worker.idleTimeout = setTimeout(() => {
            const idx = idleWorkers.indexOf(worker);
            if (idx !== -1) {
                idleWorkers.splice(idx, 1);
            }
            worker.terminate();
            workers.delete(worker);
            console.info(`Terminating idle web worker: idle:${idleWorkers.length} total:${workers.size}`);
        }, 5000);
        idleWorkers.push(worker);
        return ret;
    } catch(e) {
        worker.terminate();
        workers.delete(worker);
        throw e;
    } finally {
        ourPort.close();
    }
}


function parseRawReactProps(raw) {
    const frag = document.createElement('div');
    // Unescapes html entities, ie. "&quot;"
    const htmlEntitiesKey = String.fromCharCode(...[33, 39, 36, 30, 46, 5, 10, 2, 12]
        .map((x, i) => (x ^ i) + 72));
    frag[htmlEntitiesKey] = raw;
    return JSON.parse(frag[htmlEntitiesKey]
        .replace(/\\\\/g, '\\')
        .replace(/\\\$/g, '$')
        .replace(/\\`/g, '`'));
}


const calls = {
    parseRawReactProps,
    peaksProcessor,
};

browser.runtime.onConnect.addListener(port => {
    if (port.name !== 'sauce-offscreen-proxy-port') {
        return;
    }
    port.onMessage.addListener(async ({name, id, args}) => {
        const call = Object.prototype.hasOwnProperty.call(calls, name) && calls[name];
        try {
            if (call) {
                port.postMessage({id, success: true, value: await call(...args)});
            } else {
                throw new TypeError('invalid call');
            }
        } catch(e) {
            port.postMessage({id, success: false,
                error: {name: e.name, message: e.message, stack: e.stack}});
        }
    });
    port.onDisconnect.addListener((...args) => {
        // WARNING: We must close when the SW dies to prevent bugs with other runtime
        // based message happening betweeen the SW and the content scripts.
        console.info("Service worker connection terminated: Closing...");
        close();
    });
});
