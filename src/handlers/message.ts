import type {
  MessageUserReceipt,
  proto,
  WAMessageKey,
} from '@whiskeysockets/baileys'
import { writeFile } from 'fs/promises'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { jidNormalizedUser, toNumber } from '@whiskeysockets/baileys'
import { useLogger, usePrisma } from '../shared'
import type { BaileysEventHandler } from '../types'
import { transformPrisma } from '../utils'
import { createHash } from 'crypto'
import Session from '../../../Session'
import Long from 'long'

const getKeyAuthor = (key: WAMessageKey | undefined | null) => (key?.fromMe ? 'me' : key?.participant || key?.remoteJid) || ''

export const getMessageApiId = (sessionId: string, message: proto.IWebMessageInfo | Partial<proto.IWebMessageInfo>) => createHash('sha256').update(sessionId + message.key!.id).digest('hex')

export default function messageHandler(sessionId: string, session: Session) {
  const prisma = usePrisma()
  const logger = useLogger()
  const event = session.sock.ev
  let listening = false

  const transformMessagePrisma = (data: proto.IWebMessageInfo | Partial<proto.IWebMessageInfo>): any => {
    const obj = { ...data } as any
    if (obj.key?.id) {
      obj.apiId = getMessageApiId(sessionId, data)
    }
    for (const [key, val] of Object.entries(obj)) {
      if (val instanceof Uint8Array) {
        obj[key] = Buffer.from(val)
      } else if (typeof val === 'number' || val instanceof Long) {
        obj[key] = toNumber(val)
      } else if (typeof val === 'undefined' || val === null) {
        delete obj[key]
      } else if (Array.isArray(val)) {
        obj[key] = val.map((e: any) => transformMessagePrisma(e))
      } else if (typeof val === 'object') {
        obj[key] = transformMessagePrisma(obj[key])
      }
    }
    return obj
  }

  const getChatIdMap = async (messages: proto.IWebMessageInfo[]) => {
    const chatIds = new Set<string>()
    for (const message of messages) {
      chatIds.add(message.key.remoteJid!)
    }
    const chats = await prisma.chat.findMany({
      where: { id: { in: Array.from(chatIds) } },
      select: { id: true, pkId: true }
    })
    return new Map(chats.map(c => [c.id, c.pkId]))
  }

  const uploadFiles = async (messages: proto.IWebMessageInfo[]) => {
    return
    // for (const message of messages) {
    //   const imageMessage = message.message?.imageMessage
    //   if (imageMessage) {
    //     const buffer = await downloadMediaMessage(
    //       message,
    //       'buffer',
    //       { },
    //       {
    //         logger,
    //         reuploadRequest: session.sock.updateMediaMessage
    //       }
    //     )
    //     const filename = createHash('sha256').update(sessionId + Buffer.from(imageMessage.mediaKey!).toString('base64')).digest('hex')
    //     await writeFile('./files/' + filename, buffer)
    //   }

    //   const documentMessage = message.message?.documentMessage
    //   if (documentMessage) {
    //     logger.info('upload ' + documentMessage.url)
    //     const buffer = await downloadMediaMessage(
    //       message,
    //       'buffer',
    //       { },
    //       {
    //         logger,
    //         reuploadRequest: session.sock.updateMediaMessage
    //       }
    //     )
    //     const filename = createHash('sha256').update(sessionId + Buffer.from(documentMessage.mediaKey!).toString('base64')).digest('hex')
    //     await writeFile('./files/' + filename, buffer)
    //   }
    // }
  }

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ messages, isLatest }) => {
    try {
      const chatMap = await getChatIdMap(messages)
      const newMessages = messages.map(message => {
        return {
          chatId: chatMap.get(message.key.remoteJid!),
          ...transformMessagePrisma(message),
          remoteJid: message.key.remoteJid!,
          id: message.key.id!,
          sessionId,
        }
      })
      await prisma.$transaction(async (tx) => {
        if (isLatest) {
          await tx.message.deleteMany({ where: { sessionId } })
        }
        await tx.message.createMany({ data: newMessages })
      })
      setImmediate(() => session.webhookSend('history sync', {
        channelId: sessionId
      }))
      logger.info({ messages: messages.length }, 'Synced messages')
    } catch (e) {
      logger.error(e, 'An error occured during messages set')
    }
  }

  const upsert: BaileysEventHandler<'messages.upsert'> = async ({ messages, type }) => {
    switch (type) {
      case 'append':
      case 'notify':
        const chatMap = await getChatIdMap(messages)
        await uploadFiles(messages)
        for (const message of messages) {
          try {
            const jid = jidNormalizedUser(message.key.remoteJid!)
            const data = transformMessagePrisma(message)
            const chatId = chatMap.get(message.key.remoteJid!)
            const createData = {
              ...data,
              chatId,
              remoteJid: jid,
              id: message.key.id!,
              sessionId
            }
            await prisma.message.upsert({
              select: { pkId: true },
              create: createData,
              update: { ...data },
              where: { sessionId_remoteJid_id: { remoteJid: jid, id: message.key.id!, sessionId } },
            })
            setImmediate(() => session.webhookSend('new message', createData))

            const chatExists = (await prisma.chat.count({ where: { id: jid, sessionId } })) > 0
            if (type === 'notify' && !chatExists) {
              event.emit('chats.upsert', [
                {
                  id: jid,
                  conversationTimestamp: toNumber(message.messageTimestamp),
                  unreadCount: 1,
                },
              ])
            }
          } catch (e) {
            logger.error(e, 'An error occured during message upsert')
          }
        }
        break
    }
  }

  const update: BaileysEventHandler<'messages.update'> = async (updates) => {
    for (const { update, key } of updates) {
      await uploadFiles([update as proto.IWebMessageInfo])
      try {
        await prisma.$transaction(async (tx) => {
          const prevData = await tx.message.findFirst({
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          })
          if (!prevData) {
            return logger.info({ update }, 'Got update for non existent message')
          }

          const data = { ...prevData, ...update } as proto.IWebMessageInfo
          await tx.message.delete({
            select: { pkId: true },
            where: {
              sessionId_remoteJid_id: {
                id: key.id!,
                remoteJid: key.remoteJid!,
                sessionId,
              },
            },
          })
          const chatMap = await getChatIdMap([data])
          await tx.message.create({
            select: { pkId: true },
            data: {
              chatId: chatMap.get(data.key.remoteJid!),
              ...transformMessagePrisma(data),
              id: data.key.id!,
              remoteJid: data.key.remoteJid!,
              sessionId,
            },
          })
        })
      } catch (e) {
        logger.error(e, 'An error occured during message update')
      }
    }
    session.webhookSend('update messages', updates.map(({ key, update }) => ({
      ...update,
      key,
    })))
  }

  const del: BaileysEventHandler<'messages.delete'> = async (item) => {
    try {
      if ('all' in item) {
        await prisma.message.deleteMany({ where: { remoteJid: item.jid, sessionId } })
        return
      }

      const jid = item.keys[0].remoteJid!
      const ids = item.keys.map((k) => k.id!)
      await prisma.message.deleteMany({
        where: { id: { in: ids }, remoteJid: jid, sessionId },
      })

      session.webhookSend('delete messages', {
        ids: ids.map(id => createHash('sha256').update(sessionId + id).digest('hex'))
      })
    } catch (e) {
      logger.error(e, 'An error occured during message delete')
    }
  }

  const updateReceipt: BaileysEventHandler<'message-receipt.update'> = async (updates) => {
    for (const { key, receipt } of updates) {
      try {
        await prisma.$transaction(async (tx) => {
          const message = await tx.message.findFirst({
            select: { userReceipt: true },
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          })
          if (!message) {
            return logger.debug({ update }, 'Got receipt update for non existent message')
          }

          let userReceipt = (message.userReceipt || []) as unknown as MessageUserReceipt[]
          const recepient = userReceipt.find((m) => m.userJid === receipt.userJid)

          if (recepient) {
            userReceipt = [...userReceipt.filter((m) => m.userJid !== receipt.userJid), receipt]
          } else {
            userReceipt.push(receipt)
          }

          await tx.message.update({
            select: { pkId: true },
            data: transformPrisma({ userReceipt: userReceipt }),
            where: {
              sessionId_remoteJid_id: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
            },
          })
        })
      } catch (e) {
        logger.error(e, 'An error occured during message receipt update')
      }
    }
    session.webhookSend('update messages', updates)
  }

  const updateReaction: BaileysEventHandler<'messages.reaction'> = async (reactions) => {
    const reactionsResult = [] as {
      key: proto.IMessageKey
      reactions: proto.IReaction[]
    }[]
    for (const { key, reaction } of reactions) {
      try {
        await prisma.$transaction(async (tx) => {
          const message = await tx.message.findFirst({
            select: { reactions: true },
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          })
          if (!message) {
            return logger.debug({ update }, 'Got reaction update for non existent message')
          }

          const authorID = getKeyAuthor(reaction.key)
          const reactions = ((message.reactions || []) as proto.IReaction[])
            .filter((r) => getKeyAuthor(r.key) !== authorID)

          if (reaction.text) {
            reactions.push(reaction)
          }
          reactionsResult.push({
            key,
            reactions,
          })
          await tx.message.update({
            select: { pkId: true },
            data: {
              reactions: reactions.map(r => transformPrisma(r))
            },
            where: {
              sessionId_remoteJid_id: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
            },
          })
        })
      } catch (e) {
        logger.error(e, 'An error occured during message reaction update')
      }
    }
    session.webhookSend('update messages', reactionsResult)
  }

  const listen = () => {
    if (listening) return

    event.on('messaging-history.set', set)
    event.on('messages.upsert', upsert)
    event.on('messages.update', update)
    event.on('messages.delete', del)
    event.on('message-receipt.update', updateReceipt)
    event.on('messages.reaction', updateReaction)
    listening = true
  }

  const unlisten = () => {
    if (!listening) return

    event.off('messaging-history.set', set)
    event.off('messages.upsert', upsert)
    event.off('messages.update', update)
    event.off('messages.delete', del)
    event.off('message-receipt.update', updateReceipt)
    event.off('messages.reaction', updateReaction)
    listening = false
  }

  return { listen, unlisten }
}
