-- CreateTable
CREATE TABLE "admins" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'normal',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ban_reason" TEXT,
    "quota" INTEGER NOT NULL DEFAULT 0,
    "membership_level" TEXT NOT NULL DEFAULT 'none',
    "membership_expire_at" TIMESTAMP(3),
    "invite_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_logs" (
    "id" SERIAL NOT NULL,
    "admin_id" INTEGER NOT NULL,
    "admin_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" INTEGER,
    "target_name" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_cards" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'unused',
    "used_by_customer_id" INTEGER,
    "used_at" TIMESTAMP(3),
    "expire_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dict_types" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dict_types_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "dict_items" (
    "id" SERIAL NOT NULL,
    "type_code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "remark" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "dict_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_codes" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_username_key" ON "admins"("username");

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE INDEX "customers_created_at_idx" ON "customers"("created_at");

-- CreateIndex
CREATE INDEX "customers_status_idx" ON "customers"("status");

-- CreateIndex
CREATE INDEX "operation_logs_created_at_idx" ON "operation_logs"("created_at");

-- CreateIndex
CREATE INDEX "operation_logs_target_type_target_id_idx" ON "operation_logs"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "invite_cards_code_key" ON "invite_cards"("code");

-- CreateIndex
CREATE INDEX "invite_cards_status_idx" ON "invite_cards"("status");

-- CreateIndex
CREATE INDEX "invite_cards_used_by_customer_id_idx" ON "invite_cards"("used_by_customer_id");

-- CreateIndex
CREATE INDEX "dict_items_type_code_idx" ON "dict_items"("type_code");

-- CreateIndex
CREATE UNIQUE INDEX "dict_items_type_code_value_key" ON "dict_items"("type_code", "value");

-- CreateIndex
CREATE INDEX "login_codes_email_created_at_idx" ON "login_codes"("email", "created_at");
