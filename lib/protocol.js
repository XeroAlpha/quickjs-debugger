const { Buffer } = require("buffer");
const EventEmitter = require("events");

function addMessageListener(socket, onMessage) {
    const chunks = [];
    let bufferLength = 0;
    let state = null;
    let triggerLength = 0;
    socket.on("data", (chunk) => {
        bufferLength += chunk.length;
        chunks.push(chunk);
        while (bufferLength >= triggerLength) {
            const bufferedChunk = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
            const triggerChunk = bufferedChunk.slice(0, triggerLength);
            bufferLength -= triggerLength;
            chunks.splice(0, chunks.length, bufferedChunk.slice(triggerLength));
            switch (state) {
                case "length":
                    state = "content";
                    triggerLength = parseInt(triggerChunk.toString(), 16);
                    break;
                case "content":
                    onMessage(triggerChunk);
                    // falls through
                default:
                    state = "length";
                    triggerLength = 9;
            }
        }
    });
}

class QuickJSDebugProtocol extends EventEmitter {
    constructor(socket) {
        super();
        this.socket = socket;
        this.requestTimeout = 10000;
        this.requestSeq = 1;
        this.requestCallbacks = new Map();
        addMessageListener(socket, (message) => this.handleMessage(message));
        socket.on("end", () => {
            this.emit("end");
            this.requestCallbacks.forEach((callback) => {
                callback(new Error("Protocol is closed"));
            });
            this.requestCallbacks.clear();
        });
    }

    close() {
        this.socket.end();
    }

    sendMessage(message) {
        const buffer = Buffer.from(`${JSON.stringify(message)}\n`);
        const lf = Buffer.from("\n");
        const packet = Buffer.concat([
            Buffer.from(buffer.length.toString(16).padStart(8, "0")),
            lf,
            buffer
        ]);
        this.socket.write(packet);
    }

    sendEnvelope(type, data) {
        this.sendMessage({
            version: 1,
            type,
            ...data
        });
    }

    sendRequestRaw(command, args) {
        const { requestSeq } = this;
        this.requestSeq += 1;
        this.sendEnvelope("request", {
            request: {
                request_seq: requestSeq,
                command,
                args
            }
        });
        return requestSeq;
    }

    // eslint-disable-next-line consistent-return
    sendRequest(command, args, callback) {
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.sendRequest(command, args, (err, result) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(result);
                    }
                });
            });
        }
        const requestSeq = this.sendRequestRaw(command, args);
        let returned = false;
        let timeout;
        const timeoutError = new Error(`Request timeout ${this.requestTimeout}ms exceed.`);
        const cb = (err, body, json) => {
            if (returned) return;
            returned = true;
            callback(err, body, json);
            clearTimeout(timeout);
        };
        this.requestCallbacks.set(requestSeq, cb);
        timeout = setTimeout(() => {
            if (returned) return;
            returned = true;
            callback(timeoutError);
            this.requestCallbacks.delete(requestSeq);
        }, this.requestTimeout);
    }

    handleMessage(message) {
        const json = JSON.parse(message.toString());
        if (json.type === "event") {
            this.emit(json.event.type, json.event);
        } else if (json.type === "response") {
            const callback = this.requestCallbacks.get(json.request_seq);
            if (callback) {
                this.requestCallbacks.delete(json.request_seq);
                callback(json.error, json.body, json);
            }
        }
    }
}

module.exports = { QuickJSDebugProtocol };
