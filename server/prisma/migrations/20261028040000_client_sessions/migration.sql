-- 客户端使用会话：一次「打开软件到关闭」记一行。
--
-- 「打开软件」从 login_logs 挪到这里（取舍甲）：login_logs 是事件流，这张是计量。
-- 结束时间靠「下次启动结清」补，不靠退出时同步上报（强杀/断电写不了库）。

CREATE TABLE "client_sessions" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "end_reason" TEXT,
    "end_detail" TEXT NOT NULL DEFAULT '',
    "app_version" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    "user_agent" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_sessions_customer_id_started_at_idx" ON "client_sessions"("customer_id", "started_at");
CREATE INDEX "client_sessions_ended_at_idx" ON "client_sessions"("ended_at");
