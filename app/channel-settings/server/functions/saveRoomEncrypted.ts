import { Meteor } from 'meteor/meteor';
import { Match } from 'meteor/check';
import type { WriteOpResult } from 'mongodb';

import { Rooms, Messages } from '../../../models/server';
import type { IUser } from '../../../../definition/IUser';

export const saveRoomEncrypted = function(rid: string, encrypted: boolean, user: IUser, sendMessage = true): Promise<WriteOpResult> {
	if (!Match.test(rid, String)) {
		throw new Meteor.Error('invalid-room', 'Invalid room', {
			function: 'RocketChat.saveRoomEncrypted',
		});
	}

	const update = Rooms.saveEncryptedById(rid, encrypted);
	if (update && sendMessage) {
		const action = encrypted ? 'room-e2e-enabled' : 'room-e2e-disabled';
		Messages.createRoomSettingsChangedWithTypeRoomIdMessageAndUser(action, rid, user.username, user, {});
	}
	return update;
};