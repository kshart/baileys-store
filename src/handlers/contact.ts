import type { Contact } from '@whiskeysockets/baileys'
import { Prisma } from '@prisma/client'
import { useLogger, usePrisma } from '../shared'
import type { BaileysEventHandler } from '../types'
import { transformPrisma } from '../utils'
import { createHash } from 'crypto'
import Session from '../../../Session'


export default function contactHandler(sessionId: string, session: Session) {
  const prisma = usePrisma()
  const logger = useLogger()
  const event = session.sock.ev
  let listening = false

  const prepareModel = (model: Contact | Partial<Contact>) => {
    if (!model.id) {
      return model
    }
    return {
      ...model,
      apiId: createHash('sha256').update(sessionId + model.id).digest('hex')
    }
  }

  const fillEmptyNames = async () => {
    return
    const contactModels = await prisma.contact.findMany({
      select: {
        id: true,
        name: true,
        notify: true
      },
      where: {
        sessionId,
        name: null,
      }
    })
    const promisses = [] as Promise<any>[]
    for (const contact of contactModels) {
      let name = contact.name
      if (!name && contact.notify) {
        name = contact.notify
      }
      if (!name && contact.id) {
        name = contact.id.replace(/@.*/, '')
      }
      if (name) {
        promisses.push(prisma.contact.update({
          data: { name },
          where: { sessionId_id: { id: contact.id, sessionId } },
        }))
      }
    }
    await Promise.allSettled(promisses)
  }

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ contacts }) => {
    try {
      // const contactIds = contacts.map((c) => c.id);
      // const deletedOldContactIds = (
      //   await prisma.contact.findMany({
      //     select: { id: true },
      //     where: { id: { notIn: contactIds }, sessionId },
      //   })
      // ).map((c) => c.id);


      const upsertPromises = [] as Promise<any>[]
      for (const contact of contacts) {
        const data = transformPrisma({
          ...prepareModel(contact),
          // business: await session.sock.getBusinessProfile(contact.id)
        })
        if (data.id === '19716786701@s.whatsapp.net' && !data.name) { // Освободи свой разум
          data.name === 'Facebook'
        }
        upsertPromises.push(prisma.contact.upsert({
          select: { pkId: true },
          create: { ...data, sessionId },
          update: data,
          where: { sessionId_id: { id: data.id, sessionId } },
        }))
      }
      if (upsertPromises.length > 0) {
        await Promise.allSettled(upsertPromises);
        await fillEmptyNames()

        const contactModels = await prisma.contact.findMany({
          select: { id: true },
          where: {
            sessionId,
            imgUrl: null,
          }
        })
        // const updates = [] as Promise<any>[]
        for (const contact of contactModels) {
          logger.info('getImageFor ' + contact.id)
          await session.sock.profilePictureUrl(contact.id, 'preview')
            .catch(e => logger.error('getImageFor ' + contact.id + ' fail'))
            .then(imgUrl => {
              if (imgUrl) {
                return prisma.contact.update({
                  select: { pkId: true },
                  data: { imgUrl },
                  where: { sessionId_id: { id: contact.id, sessionId } },
                }).then(e => e)
              }
            })
        }
        // await Promise.allSettled(updates)

        logger.info({ newContacts: contacts.length }, 'Synced contacts');
      }
    } catch (e) {
      logger.error(e, 'An error occured during contacts set');
    }
  };

  const upsert: BaileysEventHandler<'contacts.upsert'> = async (contacts) => {
    try {
      const upsertPromises = [] as Promise<any>[]
      for (const contact of contacts) {
        const data = transformPrisma({
          ...prepareModel(contact),
          // business: await session.sock.getBusinessProfile(contact.id)
        })
        if (data.id === '19716786701@s.whatsapp.net' && !data.name) { // Освободи свой разум
          data.name === 'Facebook'
        }
        upsertPromises.push(prisma.contact.upsert({
          select: { pkId: true },
          create: { ...data, sessionId },
          update: data,
          where: { sessionId_id: { id: data.id, sessionId } },
        }))
      }
      if (upsertPromises.length > 0) {
        await Promise.allSettled(upsertPromises)
      }
      await fillEmptyNames()
    } catch (e) {
      logger.error(e, 'An error occured during contacts upsert');
    }
  };

  const update: BaileysEventHandler<'contacts.update'> = async (updates) => {
    for (const update of updates) {
      try {
        const data = transformPrisma({
          ...prepareModel(update),
          // business: await session.sock.getBusinessProfile(update.id!)
        })
        if (data.id === '19716786701@s.whatsapp.net' && !data.name) { // Освободи свой разум
          data.name === 'Facebook'
        }
        await prisma.contact.update({
          select: { pkId: true },
          data,
          where: { sessionId_id: { id: update.id!, sessionId } },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          return logger.info({ update }, 'Got update for non existent contact');
        }
        logger.error(e, 'An error occured during contact update');
      }
    }
    await fillEmptyNames()
  };

  const selfUpsert: BaileysEventHandler<'creds.update'> = async ({ me }) => {
    if (!me) {
      return
    }
    try {
      const imgUrl = await session.sock.profilePictureUrl(me.id, 'preview').catch(e => logger.error(e))
      const data = {
        id: me.id,
        name: me.name,
        imgUrl: imgUrl || undefined,
      }
      logger.info('getImageFor ' + data.id + ' ' + data.imgUrl)
      await prisma.contact.upsert({
        create: { ...transformPrisma(prepareModel(data)), sessionId },
        update: data,
        where: { sessionId_id: { id: data.id, sessionId } },
      })
      logger.info('Synced self contact');
    } catch (e) {
      logger.error(e, 'An error occured during contacts set');
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('contacts.upsert', upsert);
    event.on('contacts.update', update);
    event.on('creds.update', selfUpsert);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('contacts.upsert', upsert);
    event.off('contacts.update', update);
    event.off('creds.update', selfUpsert);
    listening = false;
  };

  return { listen, unlisten };
}
