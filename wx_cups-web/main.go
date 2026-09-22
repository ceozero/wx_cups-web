package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func logJSON(level, event string, fields map[string]any) {
	fields["level"] = level
	fields["event"] = event
	raw, _ := json.Marshal(fields)
	log.Print(string(raw))
}
func callbackServer(c Config, gateway *WecomKfGateway) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/wecom/kf/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		sig, ts, nonce := q.Get("msg_signature"), q.Get("timestamp"), q.Get("nonce")
		end := func(status int, body string) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("Content-Length", fmt.Sprint(len([]byte(body))))
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
		}
		if r.Method == http.MethodGet {
			encrypted := q.Get("echostr")
			if encrypted == "" || !verifyWecomSignature(c.WecomCallbackToken, sig, ts, nonce, encrypted) {
				end(401, "invalid signature")
				return
			}
			plain, err := decryptWecomPayload(encrypted, c.WecomCallbackEncodingAESKey, c.WecomCorpID)
			if err != nil {
				end(400, "invalid callback")
				return
			}
			end(200, plain)
			return
		}
		if r.Method != http.MethodPost {
			end(405, "method not allowed")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1024*1024+1))
		if err != nil || len(body) > 1024*1024 {
			end(400, "invalid callback")
			return
		}
		encrypted := encryptedValue(string(body))
		if encrypted == "" || !verifyWecomSignature(c.WecomCallbackToken, sig, ts, nonce, encrypted) {
			end(401, "invalid signature")
			return
		}
		plain, err := decryptWecomPayload(encrypted, c.WecomCallbackEncodingAESKey, c.WecomCorpID)
		if err != nil {
			logJSON("error", "wecom_callback_failed", map[string]any{"error": err.Error()})
			end(400, "invalid callback")
			return
		}
		event, token, open := parseWecomCallback(plain)
		end(200, "success")
		if event == "kf_msg_or_event" && open != "" && token != "" {
			gateway.syncFromCallback(open, token)
		}
	})
	return &http.Server{Addr: fmt.Sprintf("%s:%d", c.WecomCallbackHost, c.WecomCallbackPort), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
}
func main() {
	c, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	store, err := newStore(c.DataDir)
	if err != nil {
		log.Fatal(err)
	}
	cups := newCupsWebClient(c)
	gateway := newWecomKfGateway(c, store, newPrintGateway(c, store, cups), newWecomKfClient(c), newCupsJobStatusClient(c), cups)
	server := callbackServer(c, gateway)
	gateway.startWorkers()
	go func() {
		logJSON("info", "wecom_callback_listening", map[string]any{"host": c.WecomCallbackHost, "port": c.WecomCallbackPort})
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	logJSON("info", "shutdown", map[string]any{})
	gateway.stopWorkers()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	_ = store.Close()
}
