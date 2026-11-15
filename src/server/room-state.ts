import type { Room } from '../shared/types.js';
import type { Store } from './store.js';

export function roomDeleting(): never {
  throw Object.assign(
    new Error('This room is being deleted. Retry deletion if it did not finish.'),
    {
      statusCode: 409,
      code: 'room_deleting',
    },
  );
}

/** Check both the old and proposed scope before moving any room-owned record. */
export function assertRoomWritable(store: Store, roomId: string): Room {
  const room = store.get<Room>('rooms', roomId);
  if (room?.deletion || store.get('deletedRooms', roomId)) roomDeleting();
  if (!room) throw Object.assign(new Error('Room not found.'), { statusCode: 404 });
  return room;
}
