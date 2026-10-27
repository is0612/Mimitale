-- 客户登录记录：从哪来（IP）、用什么方式登的、什么时候。
--
-- 单独一张表不混 operation_logs —— 那张记的是「管理员做过什么」，
-- 客户登录写进去会变成「系统操作了自己」，日志页全是噪音。
--
-- 外键：按本库规矩（「不建任何外键」）只存 customer_id，不建约束。
-- 删客户时由 deleteCustomer 那条路径顺手清掉，孤儿行不影响任何统计口径。

CREATE TABLE "login_logs" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'password',
    "ip" TEXT NOT NULL DEFAULT '',
    "user_agent" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_logs_pkey" PRIMARY KEY ("id")
);

-- 详情页按客户取最近 N 条
CREATE INDEX "login_logs_customer_id_created_at_idx" ON "login_logs"("customer_id", "created_at");

-- 留着给「今天有多少人来过 / 按 IP 看来源」这类统计
CREATE INDEX "login_logs_created_at_idx" ON "login_logs"("created_at");
