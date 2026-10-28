-- AlterTable
ALTER TABLE "invite_cards" ADD COLUMN     "days" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "level" TEXT NOT NULL DEFAULT 'basic';
