import { EventEmitter } from 'events';

class StreamerCentralClass extends EventEmitter {
	public instances: Record<string, Streamer> = {};

	constructor() {
		super();
	}
}

export const StreamerCentral = new StreamerCentralClass();

export type Client = {
	ws: any;
	kind: any;
	userId: string;
	send: Function;
}

export type Publication = {
	onStop: Function;
	stop: Function;
	connection: Connection;
	_session: {
		sendAdded(publicationName: string, id: string, fields: Record<string, any>): void;
		socket?: {
			send: Function;
		};
	};
	ready: Function;
	userId: string;
	client: Client;
}

type Rule = (this: Publication, eventName: string, ...args: any) => Promise<boolean | object>;

interface IRules {
	[k: string]: Rule;
}

export type Connection = any;

export type DDPSubscription = {
	eventName: string;
	subscription: Publication;
}

export interface IStreamer {
	serverOnly: boolean;

	allowEmit(eventName: string | boolean | Rule, fn?: Rule | 'all' | 'none' | 'logged'): void;

	allowWrite(eventName: string | boolean | Rule, fn?: Rule | 'all' | 'none' | 'logged'): void;

	allowRead(eventName: string | boolean | Rule, fn?: Rule | 'all' | 'none' | 'logged'): void;

	emit(event: string, ...data: any[]): void;

	__emit(...data: any[]): void;

	emitWithoutBroadcast(event: string, ...data: any[]): void;
}

export interface IStreamerConstructor {
	// eslint-disable-next-line @typescript-eslint/no-misused-new
	new(name: string, options?: {retransmit?: boolean; retransmitToSelf?: boolean}): IStreamer;
}

export abstract class Streamer extends EventEmitter implements IStreamer {
	protected subscriptions = new Set<DDPSubscription>();

	protected subscriptionsByEventName = new Map<string, Set<DDPSubscription>>();

	public retransmit = true;

	public retransmitToSelf = false;

	public serverOnly = false;

	private _allowRead: IRules = {};

	private _allowWrite: IRules = {};

	private _allowEmit: IRules = {};

	constructor(
		public name: string,
		{ retransmit = true, retransmitToSelf = false }: {retransmit?: boolean; retransmitToSelf?: boolean } = { },
	) {
		super();

		if (StreamerCentral.instances[name]) {
			console.warn('Streamer instance already exists:', name);
			return StreamerCentral.instances[name];
		}

		StreamerCentral.instances[name] = this;

		this.retransmit = retransmit;
		this.retransmitToSelf = retransmitToSelf;

		this.iniPublication();
		// DDPStreamer doesn't have this
		this.initMethod();

		this.allowRead('none');
		this.allowEmit('all');
		this.allowWrite('none');
	}

	get subscriptionName(): string {
		return `stream-${ this.name }`;
	}

	private allow(rules: IRules, name: string) {
		return (eventName: string | boolean | Rule, fn?: string | boolean | Rule): void => {
			if (fn === undefined) {
				fn = eventName;
				eventName = '__all__';
			}

			if (typeof eventName !== 'string') {
				return;
			}

			if (typeof fn === 'function') {
				rules[eventName] = fn;
				return;
			}

			if (typeof fn === 'string' && ['all', 'none', 'logged'].indexOf(fn) === -1) {
				console.error(`${ name } shortcut '${ fn }' is invalid`);
			}

			if (fn === 'all' || fn === true) {
				rules[eventName] = async function(): Promise<boolean> {
					return true;
				};
				return;
			}

			if (fn === 'none' || fn === false) {
				rules[eventName] = async function(): Promise<boolean> {
					return false;
				};
				return;
			}

			if (fn === 'logged') {
				rules[eventName] = async function(): Promise<boolean> {
					return Boolean(this.userId);
				};
			}
		};
	}

	allowRead(eventName: string | boolean | Rule, fn?: Rule | 'all' | 'none' | 'logged'): void {
		this.allow(this._allowRead, 'allowRead')(eventName, fn);
	}

	allowWrite(eventName: string | boolean | Rule, fn?: Rule | 'all' | 'none' | 'logged'): void {
		this.allow(this._allowWrite, 'allowWrite')(eventName, fn);
	}

	allowEmit(eventName: string | boolean | Rule, fn?: Rule | 'all' | 'none' | 'logged'): void {
		this.allow(this._allowEmit, 'allowEmit')(eventName, fn);
	}

	private isAllowed(rules: IRules) {
		return async (scope: Publication, eventName: string, args: any): Promise<boolean | object> => {
			if (rules[eventName]) {
				return rules[eventName].call(scope, eventName, ...args);
			}

			return rules.__all__.call(scope, eventName, ...args);
		};
	}

	async isReadAllowed(scope: Publication, eventName: string, args: any): Promise<boolean | object> {
		return this.isAllowed(this._allowRead)(scope, eventName, args);
	}

	async isEmitAllowed(scope: Publication, eventName: string, ...args: any[]): Promise<boolean | object> {
		return this.isAllowed(this._allowEmit)(scope, eventName, args);
	}

	async isWriteAllowed(scope: Publication, eventName: string, args: any): Promise<boolean | object> {
		return this.isAllowed(this._allowWrite)(scope, eventName, args);
	}

	addSubscription(subscription: DDPSubscription, eventName: string): void {
		this.subscriptions.add(subscription);

		const subByEventName = this.subscriptionsByEventName.get(eventName) || new Set();
		subByEventName.add(subscription);

		this.subscriptionsByEventName.set(eventName, subByEventName);
	}

	removeSubscription(subscription: DDPSubscription, eventName: string): void {
		this.subscriptions.delete(subscription);

		const subByEventName = this.subscriptionsByEventName.get(eventName);
		if (subByEventName) {
			subByEventName.delete(subscription);
		}
	}

	async _publish(publication: Publication, eventName: string, options: boolean | {useCollection?: boolean; args?: any} = false): Promise<void> {
		let useCollection;
		let args = [];

		if (typeof options === 'boolean') {
			useCollection = options;
		} else {
			if (options.useCollection) {
				useCollection = options.useCollection;
			}

			if (options.args) {
				args = options.args;
			}
		}

		if (eventName.length === 0) {
			publication.stop();
			throw new Error('invalid-event-name');
		}

		if (await this.isReadAllowed(publication, eventName, args) !== true) {
			publication.stop();
			throw new Error('not-allowed');
		}

		const subscription = {
			subscription: publication,
			eventName,
		};

		this.addSubscription(subscription, eventName);

		publication.onStop(() => {
			this.removeSubscription(subscription, eventName);
		});

		// DDPStreamer doesn't have this
		if (useCollection === true) {
			// Collection compatibility
			publication._session.sendAdded(this.subscriptionName, 'id', {
				eventName,
			});
		}

		publication.ready();
	}

	abstract registerPublication(name: string, fn: (eventName: string, options: boolean | {useCollection?: boolean; args?: any}) => void): void;

	iniPublication(): void {
		const { _publish } = this;
		this.registerPublication(this.subscriptionName, function(this: Publication, eventName: string, options: boolean | {useCollection?: boolean; args?: any}) {
			return _publish(this, eventName, options);
		});
	}

	abstract registerMethod(methods: Record<string, (eventName: string, ...args: any[]) => any>): void;

	initMethod(): void {
		const { isWriteAllowed, __emit, _emit, retransmit } = this;

		const method: Record<string, (eventName: string, ...args: any[]) => any> = {
			async [this.subscriptionName](this: Publication, eventName, ...args): Promise<void> {
				if (await isWriteAllowed(this, eventName, args) !== true) {
					return;
				}

				__emit(eventName, ...args);

				if (retransmit === true) {
					_emit(eventName, args, this.connection, true);
				}
			},
		};

		try {
			this.registerMethod(method);
		} catch (e) {
			console.error(e);
		}
	}

	abstract changedPayload(collection: string, id: string, fields: Record<string, any>): string | false;

	_emit(eventName: string, args: any[], origin: Connection | undefined, broadcast: boolean): boolean {
		if (broadcast === true) {
			StreamerCentral.emit('broadcast', this.name, eventName, args);
		}

		const subscriptions = this.subscriptionsByEventName.get(eventName);
		if (!subscriptions || !subscriptions.size) {
			return false;
		}

		const msg = this.changedPayload(this.subscriptionName, 'id', {
			eventName,
			args,
		});

		if (!msg) {
			return false;
		}

		this.sendToManySubscriptions(subscriptions, origin, eventName, args, msg);

		return true;
	}

	async sendToManySubscriptions(subscriptions: Set<DDPSubscription>, origin: Connection | undefined, eventName: string, args: any[], msg: string): Promise<void> {
		subscriptions.forEach((subscription) => {
			if (this.retransmitToSelf === false && origin && origin === subscription.subscription.connection) {
				return;
			}

			if (this.isEmitAllowed(subscription.subscription, eventName, ...args)) {
				subscription.subscription._session.socket?.send(msg);
			}
		});
	}

	emit(eventName: string, ...args: any[]): boolean {
		return this._emit(eventName, args, undefined, true);
	}

	__emit(eventName: string, ...args: any[]): boolean {
		return super.emit(eventName, ...args);
	}

	emitWithoutBroadcast(eventName: string, ...args: any[]): void {
		this._emit(eventName, args, undefined, false);
	}
}