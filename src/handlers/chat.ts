import type { Chat } from '@whiskeysockets/baileys'
import { Prisma } from '@prisma/client'
import { useLogger, usePrisma } from '../shared'
import type { BaileysEventHandler } from '../types'
import { transformPrisma } from '../utils'
import { createHash } from 'crypto'
import Session from '../../../Session'


export default function chatHandler(sessionId: string, session: Session) {
  const prisma = usePrisma()
  const logger = useLogger()
  const event = session.sock.ev
  let listening = false

  const prepareModel = (model: Chat | Partial<Chat>) => {
    if (!model.id) {
      return model
    }
    return {
      ...model,
      apiId: createHash('sha256').update(sessionId + model.id).digest('hex')
    }
  }

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ chats, isLatest }) => {
    try {
      await prisma.$transaction(async (tx) => {
        if (isLatest) {
          await tx.chat.deleteMany({ where: { sessionId } })
        }

        const existingIds = (
          await tx.chat.findMany({
            select: { id: true },
            where: { id: { in: chats.map((c) => c.id) }, sessionId },
          })
        ).map((i) => i.id);
        const newChats = chats
          .filter((c) => !existingIds.includes(c.id))
          .map((c) => ({ ...transformPrisma(prepareModel(c)), sessionId }))
        const chatsAdded = (await tx.chat.createMany({ data: newChats })).count
        setImmediate(() => {
          for (const chat of newChats) {
            session.webhookSend('new dialog', chat)
          }
        })

        await tx.$executeRaw`
          UPDATE "Message"
          SET "chatId" = "Chat"."pkId"
          FROM "Chat"
          WHERE "Chat"."id" = "Message"."remoteJid"
            AND "Message"."sessionId" = "Chat"."sessionId"
            AND "Chat"."sessionId" = ${sessionId}
        `

        logger.info({ chatsAdded }, 'Synced chats');
      });
    } catch (e) {
      logger.error(e, 'An error occured during chats set');
    }
  };

  const upsert: BaileysEventHandler<'chats.upsert'> = async (chats) => {
    try {
      const updateChats = chats.map((c) => transformPrisma(prepareModel(c)))
      await Promise.allSettled(
        updateChats.map((data) => prisma.chat.upsert({
          select: { pkId: true },
          create: { ...data, sessionId },
          update: data,
          where: { sessionId_id: { id: data.id, sessionId } },
        }))
      );
      setImmediate(() => {
        for (const chat of updateChats) {
          session.webhookSend('new dialog', chat)
        }
      })
    } catch (e) {
      logger.error(e, 'An error occured during chats upsert');
    }
  };

  const update: BaileysEventHandler<'chats.update'> = async (updates) => {
    for (const update of updates) {
      try {
        const data = transformPrisma(prepareModel(update));
        await prisma.chat.update({
          select: { pkId: true },
          data: {
            ...data,
            unreadCount:
              typeof data.unreadCount === 'number'
                ? data.unreadCount > 0
                  ? { increment: data.unreadCount }
                  : { set: data.unreadCount }
                : undefined,
          },
          where: { sessionId_id: { id: update.id!, sessionId } },
        });
        setImmediate(() => session.webhookSend('update dialog', data))
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          return logger.info({ update }, 'Got update for non existent chat');
        }
        logger.error(e, 'An error occured during chat update');
      }
    }
  };

  const del: BaileysEventHandler<'chats.delete'> = async (ids) => {
    try {
      await prisma.chat.deleteMany({
        where: { id: { in: ids } },
      });
      setImmediate(() => session.webhookSend('delete dialogs', ids))
    } catch (e) {
      logger.error(e, 'An error occured during chats delete');
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('chats.upsert', upsert);
    event.on('chats.update', update);
    event.on('chats.delete', del);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('chats.upsert', upsert);
    event.off('chats.update', update);
    event.off('chats.delete', del);
    listening = false;
  };

  return { listen, unlisten };
}
