import { AppError } from '../utils/errors.js';

/**
 * Self-registration: a restaurant owner creates their own restaurant.
 * Reuses the normal provisioning (same isolation, same checks) with a trial period,
 * then sets the owner's password through the normal one-time setup flow and signs them in.
 */
export class SignupService {
  #provisioning;
  #authService;
  #trialDays;
  #enabled;

  constructor({ provisioning, authService, trialDays = 7, enabled = true }) {
    this.#provisioning = provisioning;
    this.#authService = authService;
    this.#trialDays = trialDays;
    this.#enabled = enabled;
  }

  get trialDays() {
    return this.#trialDays;
  }

  async signup(input, { ip, userAgent }) {
    if (!this.#enabled) {
      throw new AppError(403, 'Self sign-up is currently closed', { code: 'SIGNUP_DISABLED' });
    }
    const result = await this.#provisioning.create(
      {
        name: input.restaurantName,
        slug: input.slug,
        phone: input.phone,
        owner: { name: input.ownerName, email: input.email, phone: input.phone },
      },
      { actor: { id: 'self-signup', email: input.email }, ip, trialDays: this.#trialDays },
    );
    const token = result.owner.setupUrl.split('#token=')[1];
    return this.#authService.setupPassword({ token, password: input.password, ip, userAgent });
  }
}
