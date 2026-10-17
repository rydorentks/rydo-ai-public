import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import OpenAI from 'openai';
import PocketBase from 'pocketbase';

dotenv.config({
  path: new URL('./.env', import.meta.url),
});

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
  }),
);

app.use(
  express.json({
    limit: '256kb',
  }),
);

const PB_URL = process.env.POCKETBASE_URL || '';
const MODEL =
  process.env.OPENROUTER_MODEL || 'openrouter/free';

const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://rydo-rent.expo.app',
    'X-Title': 'RYDO AI',
  },
});

/* =========================================================
   BASIC HELPERS
========================================================= */

function text(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value) {
  return Math.round(number(value) * 100) / 100;
}

function safeId(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function cleanHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter(
      (item) =>
        item &&
        (item.role === 'user' ||
          item.role === 'assistant') &&
        typeof item.content === 'string',
    )
    .slice(-12)
    .map((item) => ({
      role: item.role,
      content: item.content.slice(0, 4000),
    }));
}

function isInactiveStatus(status) {
  return [
    'inactive',
    'rejected',
    'disabled',
    'deleted',
    'suspended',
  ].includes(lower(status));
}

function isBlockingBookingStatus(status) {
  return [
    'pending',
    'accepted',
    'active',
    'confirmed',
    'ongoing',
    'in_progress',
  ].includes(lower(status));
}

function isCompletedBooking(status) {
  return lower(status) === 'completed';
}

function isCancelledBooking(status) {
  return [
    'cancelled',
    'canceled',
    'rejected',
    'declined',
    'expired',
  ].includes(lower(status));
}

/* =========================================================
   DATE HELPERS
========================================================= */

function parseDateValue(value) {
  if (!value) {
    return null;
  }

  const raw = String(value).trim();

  if (!raw) {
    return null;
  }

  const iso = new Date(raw);

  if (!Number.isNaN(iso.getTime())) {
    return iso;
  }

  const match = raw.match(
    /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/,
  );

  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const year = Number(match[3]);

    const date = new Date(
      year,
      month,
      day,
    );

    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

function getBookingStart(booking) {
  return (
    booking.pickUp ||
    booking.pickup ||
    booking.pickupDateTime ||
    booking.pickupAt ||
    booking.startDate ||
    booking.startDateTime ||
    booking.from ||
    booking.dateFrom ||
    null
  );
}

function getBookingEnd(booking) {
  return (
    booking.returnDate ||
    booking.returnDateTime ||
    booking.returnAt ||
    booking.endDate ||
    booking.endDateTime ||
    booking.to ||
    booking.dateTo ||
    null
  );
}

function getBookingCarId(booking) {
  return (
    booking.carId ||
    booking.car ||
    booking.vehicleId ||
    booking.vehicle ||
    null
  );
}

function datesOverlap(
  startA,
  endA,
  startB,
  endB,
) {
  if (
    !startA ||
    !endA ||
    !startB ||
    !endB
  ) {
    return false;
  }

  return (
    startA < endB &&
    endA > startB
  );
}

function getBookingDays(booking) {
  const explicit = number(
    booking.days,
    0,
  );

  if (explicit > 0) {
    return explicit;
  }

  const start = parseDateValue(
    getBookingStart(booking),
  );

  const end = parseDateValue(
    getBookingEnd(booking),
  );

  if (!start || !end) {
    return 0;
  }

  const diff =
    end.getTime() -
    start.getTime();

  const days = Math.ceil(
    diff / 86400000,
  );

  return Math.max(days, 0);
}

/* =========================================================
   PRICE HELPERS
========================================================= */

function getDailyPrice(car) {
  return number(
    car.dailyPrice ??
      car.price ??
      0,
    0,
  );
}

function getPrice3to6(car) {
  return number(
    car.price3to6 ?? 0,
    0,
  );
}

function getPrice7to29(car) {
  return number(
    car.price7to29 ?? 0,
    0,
  );
}

function getWeekendPrice(car) {
  return number(
    car.weekendPrice ?? 0,
    0,
  );
}

function getMonthlyPrice(car) {
  return number(
    car.monthlyPrice ?? 0,
    0,
  );
}

function getEstimatedDailyEquivalent(
  car,
  days,
) {
  const d = Math.max(
    number(days, 1),
    1,
  );

  if (
    d >= 30 &&
    getMonthlyPrice(car) > 0
  ) {
    return roundMoney(
      getMonthlyPrice(car) / 30,
    );
  }

  if (
    d >= 7 &&
    getPrice7to29(car) > 0
  ) {
    return roundMoney(
      getPrice7to29(car),
    );
  }

  if (
    d >= 3 &&
    d <= 6 &&
    getPrice3to6(car) > 0
  ) {
    return roundMoney(
      getPrice3to6(car),
    );
  }

  return roundMoney(
    getDailyPrice(car),
  );
}

/* =========================================================
   CAR IMAGE HELPERS
========================================================= */

function getCarImageFilename(car) {
  const mainPhoto = text(
    car?.mainPhoto,
  );

  if (mainPhoto) {
    return mainPhoto;
  }

  if (Array.isArray(car?.photos)) {
    const firstPhoto =
      car.photos.find((photo) =>
        Boolean(text(photo)),
      );

    if (firstPhoto) {
      return text(firstPhoto);
    }
  }

  return '';
}

function getCarImageUrl(car) {
  const filename =
    getCarImageFilename(car);

  if (!filename) {
    return null;
  }

  if (
    /^(https?:|data:|blob:)/i.test(
      filename,
    )
  ) {
    return filename;
  }

  if (
    !PB_URL ||
    !car?.id
  ) {
    return null;
  }

  return `${PB_URL.replace(
    /\/+$/,
    '',
  )}/api/files/cars/${encodeURIComponent(
    String(car.id),
  )}/${encodeURIComponent(
    filename,
  )}`;
}

/* =========================================================
   BOOKING STATE
========================================================= */

function getCarBookingState(
  car,
  bookings,
) {
  const carId = String(car.id);

  const relevantBookings =
    bookings.filter(
      (booking) => {
        const bookingCarId =
          String(
            getBookingCarId(
              booking,
            ) || '',
          );

        return (
          bookingCarId === carId &&
          isBlockingBookingStatus(
            booking.status,
          )
        );
      },
    );

  const now = new Date();

  const activeBooking =
    relevantBookings.find(
      (booking) => {
        const start =
          parseDateValue(
            getBookingStart(
              booking,
            ),
          );

        const end =
          parseDateValue(
            getBookingEnd(
              booking,
            ),
          );

        if (!start || !end) {
          return false;
        }

        return datesOverlap(
          start,
          end,
          now,
          new Date(
            now.getTime() + 1000,
          ),
        );
      },
    );

  const futureBookings =
    relevantBookings.filter(
      (booking) => {
        const start =
          parseDateValue(
            getBookingStart(
              booking,
            ),
          );

        const end =
          parseDateValue(
            getBookingEnd(
              booking,
            ),
          );

        if (!start || !end) {
          return false;
        }

        return end > now;
      },
    );

  return {
    inactive: isInactiveStatus(
      car.status,
    ),

    bookedNow:
      Boolean(activeBooking),

    availableNow:
      !isInactiveStatus(
        car.status,
      ) &&
      !activeBooking,

    activeBooking:
      activeBooking
        ? {
            id: activeBooking.id,
            bookingNumber:
              activeBooking.bookingNumber ||
              null,
            status:
              activeBooking.status,
            pickup:
              getBookingStart(
                activeBooking,
              ),
            returnDate:
              getBookingEnd(
                activeBooking,
              ),
          }
        : null,

    scheduledBookings:
      futureBookings.map(
        (booking) => ({
          id: booking.id,
          bookingNumber:
            booking.bookingNumber ||
            null,
          status:
            booking.status,
          pickup:
            getBookingStart(
              booking,
            ),
          returnDate:
            getBookingEnd(
              booking,
            ),
          days:
            getBookingDays(
              booking,
            ),
        }),
      ),
  };
}

/* =========================================================
   POCKETBASE
========================================================= */

async function getAuthenticatedUser(
  req,
) {
  const header = String(
    req.headers.authorization ||
      '',
  );

  if (
    !header
      .toLowerCase()
      .startsWith('bearer ')
  ) {
    throw new Error(
      'Missing RYDO session.',
    );
  }

  const token =
    header.slice(7).trim();

  if (!token) {
    throw new Error(
      'Missing RYDO session.',
    );
  }

  const pb = new PocketBase(
    PB_URL,
  );

  pb.autoCancellation(false);

  pb.authStore.save(
    token,
    null,
  );

  const auth =
    await pb
      .collection('users')
      .authRefresh();

  return {
    pb,
    user: auth.record,
  };
}

async function getBusinessProfile(
  pb,
  userId,
) {
  try {
    const result =
      await pb
        .collection(
          'business_profiles',
        )
        .getList(1, 1, {
          filter: `ownerId = "${safeId(
            userId,
          )}"`,
          sort: '-created',
        });

    return (
      result.items?.[0] ||
      null
    );
  } catch (error) {
    console.error(
      'Business profile error:',
      error?.message || error,
    );

    return null;
  }
}

async function getBusinessStatus(
  pb,
  userId,
) {
  const profile =
    await getBusinessProfile(
      pb,
      userId,
    );

  return (
    lower(profile?.status) ===
    'approved'
  );
}

function resolveRole(
  user,
  businessApproved,
) {
  const role = lower(
    user?.role,
  );

  if (role === 'admin') {
    return 'admin';
  }

  if (
    role === 'owner' &&
    businessApproved
  ) {
    return 'business';
  }

  if (role === 'owner') {
    return 'owner';
  }

  return 'client';
}

async function listSafe(
  pb,
  collection,
  options = {},
) {
  try {
    const params = {
      sort:
        options.sort ||
        '-created',
      batch:
        options.batch ||
        200,
    };

    if (options.filter) {
      params.filter =
        options.filter;
    }

    const items =
      await pb
        .collection(collection)
        .getFullList(params);

    return {
      items: Array.isArray(
        items,
      )
        ? items
        : [],
      error: null,
    };
  } catch (error) {
    console.error(
      `PocketBase ${collection} error:`,
      error?.message || error,
    );

    return {
      items: [],
      error:
        error?.message ||
        'PocketBase collection unavailable',
    };
  }
}

/* =========================================================
   RYDO PLATFORM KNOWLEDGE
========================================================= */

function getRydoPlatformKnowledge() {
  return {
    platform: 'RYDO',
    market: 'Kosovo',

    mainPurpose:
      'RYDO is a platform for car rental and related mobility services.',

    services: [
      'Rent a Car',
      'Ride',
      'Delivery',
      'Car booking',
      'Owner vehicle listings',
      'Business fleet management',
      'Wallet',
      'RYDO Points',
      'User profiles',
      'Reviews',
      'Verification',
      'Business profiles',
    ],

    clientFeatures: [
      'Browse rental cars',
      'Compare cars',
      'View vehicle details',
      'Check availability',
      'Book a vehicle',
      'Check booking status',
      'Check payment status',
      'Wallet',
      'RYDO Points',
      'Pickup and delivery options',
      'Airport pickup when available',
      'Reviews',
      'Profile management',
      'Support through RYDO AI',
    ],

    ownerFeatures: [
      'Add vehicles',
      'Manage vehicles',
      'Vehicle photos',
      'Vehicle descriptions',
      'Vehicle pricing',
      '3-6 day pricing',
      '7-29 day pricing',
      'Weekend pricing',
      'Monthly pricing',
      'Delivery availability',
      'Vehicle availability',
      'Booking management',
      'Earnings tracking',
      'Fleet analysis',
      'Promotion planning',
      'Listing improvement',
      'Business profile application',
    ],

    businessFeatures: [
      'Business profile',
      'Fleet management',
      'Multiple vehicles',
      'Fleet availability',
      'Bookings',
      'Revenue analysis',
      'Pricing analysis',
      'Utilization analysis',
      'Promotion planning',
      'Business growth recommendations',
    ],

    adminFeatures: [
      'Platform overview',
      'User monitoring',
      'Car monitoring',
      'Booking monitoring',
      'Business profile monitoring',
      'Verification monitoring',
      'Dispute monitoring',
      'Revenue overview',
      'Commission overview',
      'Platform growth analysis',
      'Operational recommendations',
    ],

    carPricingFields: [
      'dailyPrice',
      'price',
      'price3to6',
      'price7to29',
      'weekendPrice',
      'monthlyPrice',
    ],

    importantRules: [
      'AI is an assistant and recommender.',
      'AI does not directly execute bookings or financial transactions.',
      'AI does not approve verification.',
      'AI does not delete records.',
      'AI must use live PocketBase data when available.',
      'AI must not invent unavailable data.',
    ],
  };
}

/* =========================================================
   CLIENT CONTEXT
========================================================= */

async function buildClientContext(
  pb,
  user,
  bookings,
  allCars,
) {
  const userId =
    String(user.id);

  const [
    myBookings,
    wallet,
    points,
  ] = await Promise.all([
    listSafe(
      pb,
      'rydo_bookings_v2',
      {
        filter: `clientId = "${safeId(
          userId,
        )}"`,
        sort: '-created',
      },
    ),

    listSafe(
      pb,
      'rydo_wallets',
      {
        filter: `userId = "${safeId(
          userId,
        )}"`,
        sort: '-created',
      },
    ),

    listSafe(
      pb,
      'rydo_point_transactions',
      {
        filter: `userId = "${safeId(
          userId,
        )}"`,
        sort: '-created',
      },
    ),
  ]);

  const publicCars =
    allCars.filter(
      (car) =>
        !isInactiveStatus(
          car.status,
        ),
    );

  const carsWithAvailability =
    publicCars.map(
      (car) => {
        const state =
          getCarBookingState(
            car,
            bookings,
          );

        return {
          id: car.id,
          name: car.name,
          brand: car.brand,
          model: car.model,
          year: car.year,

          dailyPrice:
            getDailyPrice(car),

          price:
            number(
              car.price ??
                car.dailyPrice ??
                0,
            ),

          price3to6:
            getPrice3to6(car),

          price7to29:
            getPrice7to29(car),

          weekendPrice:
            getWeekendPrice(car),

          monthlyPrice:
            getMonthlyPrice(car),

          city:
            car.city || null,

          location:
            car.location || null,

          transmission:
            car.transmission ||
            null,

          fuel:
            car.fuel || null,

          seats:
            car.seats || null,

          description:
            car.description ||
            null,

          deliveryAvailable:
            Boolean(
              car.deliveryAvailable,
            ),

          venue:
            car.venue || null,

          status:
            car.status || null,

          mainPhoto:
            car.mainPhoto ||
            null,

          photos:
            Array.isArray(
              car.photos,
            )
              ? car.photos.slice(
                  0,
                  5,
                )
              : [],

          availableNow:
            state.availableNow,

          bookedNow:
            state.bookedNow,

          scheduledBookings:
            state.scheduledBookings,
        };
      },
    );

  return {
    user: {
      id: userId,
      name:
        user.name ||
        user.fullName ||
        '',
      role: 'client',
    },

    myBookings:
      myBookings.items.map(
        (b) => ({
          id: b.id,

          bookingNumber:
            b.bookingNumber ||
            null,

          carId:
            getBookingCarId(b),

          carName:
            b.carName ||
            null,

          status:
            b.status ||
            null,

          pickup:
            getBookingStart(b),

          returnDate:
            getBookingEnd(b),

          days:
            getBookingDays(b),

          total:
            number(
              b.total,
              0,
            ),

          depositStatus:
            b.depositStatus ||
            null,

          paymentStatus:
            b.paymentStatus ||
            null,

          created:
            b.created ||
            null,
        }),
      ),

    wallet:
      wallet.items?.[0]
        ? {
            balance:
              number(
                wallet.items[0]
                  .balance,
                0,
              ),

            currency:
              wallet.items[0]
                .currency ||
              'EUR',

            rewardPoints:
              number(
                wallet.items[0]
                  .rewardPoints,
                0,
              ),
          }
        : null,

    points:
      points.items
        .slice(0, 100)
        .map((p) => ({
          points:
            number(
              p.points,
              0,
            ),

          amount:
            number(
              p.amount,
              0,
            ),

          description:
            p.description ||
            null,

          created:
            p.created ||
            null,
        })),

    fleetAvailability: {
      totalPublicCars:
        carsWithAvailability.length,

      availableNow:
        carsWithAvailability.filter(
          (c) =>
            c.availableNow,
        ).length,

      bookedNow:
        carsWithAvailability.filter(
          (c) =>
            c.bookedNow,
        ).length,
    },

    availableCars:
      carsWithAvailability,
  };
}

/* =========================================================
   OWNER / BUSINESS ANALYTICS
========================================================= */

function calculateCarAnalytics(
  car,
  bookings,
) {
  const carBookings =
    bookings.filter(
      (booking) =>
        String(
          getBookingCarId(
            booking,
          ) || '',
        ) === String(car.id),
    );

  const validBookings =
    carBookings.filter(
      (booking) =>
        !isCancelledBooking(
          booking.status,
        ),
    );

  const completed =
    validBookings.filter(
      (booking) =>
        isCompletedBooking(
          booking.status,
        ),
    );

  const active =
    validBookings.filter(
      (booking) =>
        isBlockingBookingStatus(
          booking.status,
        ),
    );

  const totalBookingDays =
    validBookings.reduce(
      (sum, booking) =>
        sum +
        getBookingDays(
          booking,
        ),
      0,
    );

  const revenue =
    completed.reduce(
      (sum, booking) =>
        sum +
        number(
          booking.total,
          0,
        ),
      0,
    );

  const ownerRevenue =
    completed.reduce(
      (sum, booking) =>
        sum +
        number(
          booking.ownerEarning ??
            booking.ownerRevenue ??
            booking.total ??
            0,
          0,
        ),
      0,
    );

  const state =
    getCarBookingState(
      car,
      bookings,
    );

  return {
    id: car.id,

    name:
      car.name ||
      `${car.brand || ''} ${
        car.model || ''
      }`.trim(),

    brand:
      car.brand || null,

    model:
      car.model || null,

    year:
      car.year || null,

    dailyPrice:
      getDailyPrice(car),

    price3to6:
      getPrice3to6(car),

    price7to29:
      getPrice7to29(car),

    weekendPrice:
      getWeekendPrice(car),

    monthlyPrice:
      getMonthlyPrice(car),

    status:
      car.status || null,

    city:
      car.city || null,

    location:
      car.location || null,

    availableNow:
      state.availableNow,

    bookedNow:
      state.bookedNow,

    bookings:
      validBookings.length,

    completedBookings:
      completed.length,

    activeBookings:
      active.length,

    bookingDays:
      totalBookingDays,

    revenue:
      roundMoney(revenue),

    ownerRevenue:
      roundMoney(
        ownerRevenue,
      ),

    scheduledBookings:
      state.scheduledBookings,
  };
}

function buildPricingSignals(
  cars,
  bookings,
) {
  return cars.map((car) => {
    const analytics =
      calculateCarAnalytics(
        car,
        bookings,
      );

    const signals = [];

    if (
      analytics.availableNow &&
      analytics.bookings === 0
    ) {
      signals.push(
        'no_booking_history',
      );
    }

    if (
      analytics.availableNow &&
      analytics.completedBookings === 0 &&
      analytics.bookings > 0
    ) {
      signals.push(
        'no_completed_bookings',
      );
    }

    if (
      analytics.bookings >= 5 &&
      analytics.completedBookings >= 3
    ) {
      signals.push(
        'strong_booking_history',
      );
    }

    if (
      analytics.dailyPrice <= 0
    ) {
      signals.push(
        'missing_daily_price',
      );
    }

    if (
      analytics.dailyPrice > 0 &&
      analytics.dailyPrice < 30
    ) {
      signals.push(
        'low_daily_price',
      );
    }

    if (
      analytics.dailyPrice >= 60
    ) {
      signals.push(
        'premium_daily_price',
      );
    }

    return {
      carId:
        analytics.id,

      carName:
        analytics.name,

      signals,
    };
  });
}

async function buildOwnerContext(
  pb,
  user,
  role,
  allCars,
  allBookings,
) {
  const userId =
    String(user.id);

  const [
    business,
    ownCars,
    ownBookings,
  ] = await Promise.all([
    listSafe(
      pb,
      'business_profiles',
      {
        filter: `ownerId = "${safeId(
          userId,
        )}"`,
        sort: '-created',
      },
    ),

    listSafe(
      pb,
      'cars',
      {
        filter: `ownerId = "${safeId(
          userId,
        )}"`,
        sort: '-created',
      },
    ),

    listSafe(
      pb,
      'rydo_bookings_v2',
      {
        filter: `ownerId = "${safeId(
          userId,
        )}"`,
        sort: '-created',
      },
    ),
  ]);

  const cars =
    ownCars.items;

  const bookings =
    ownBookings.items;

  const completed =
    bookings.filter(
      (b) =>
        isCompletedBooking(
          b.status,
        ),
    );

  const activeBookings =
    bookings.filter(
      (b) =>
        isBlockingBookingStatus(
          b.status,
        ),
    );

  const cancelled =
    bookings.filter(
      (b) =>
        isCancelledBooking(
          b.status,
        ),
    );

  const revenue =
    completed.reduce(
      (sum, booking) =>
        sum +
        number(
          booking.total,
          0,
        ),
      0,
    );

  const ownerRevenue =
    completed.reduce(
      (sum, booking) =>
        sum +
        number(
          booking.ownerEarning ??
            booking.ownerRevenue ??
            booking.total ??
            0,
          0,
        ),
      0,
    );

  const fleet =
    cars.map((car) =>
      calculateCarAnalytics(
        car,
        bookings,
      ),
    );

  const pricingSignals =
    buildPricingSignals(
      cars,
      bookings,
    );

  const carsWithBookings =
    fleet.filter(
      (car) =>
        car.bookings > 0,
    ).length;

  const carsWithoutBookings =
    fleet.filter(
      (car) =>
        car.bookings === 0,
    ).length;

  const utilizationRate =
    cars.length > 0
      ? roundMoney(
          (carsWithBookings /
            cars.length) *
            100,
        )
      : 0;

  const averageBookingValue =
    completed.length > 0
      ? roundMoney(
          revenue /
            completed.length,
        )
      : 0;

  return {
    user: {
      id: userId,

      name:
        user.name ||
        user.fullName ||
        '',

      role,
    },

    business:
      business.items?.[0]
        ? {
            id:
              business.items[0]
                .id,

            businessName:
              business.items[0]
                .businessName ||
              null,

            phone:
              business.items[0]
                .phone ||
              null,

            city:
              business.items[0]
                .city ||
              null,

            status:
              business.items[0]
                .status ||
              null,

            carsCount:
              number(
                business.items[0]
                  .carsCount,
                0,
              ),
          }
        : null,

    fleet: {
      totalCars:
        cars.length,

      activeCars:
        cars.filter(
          (c) =>
            !isInactiveStatus(
              c.status,
            ),
        ).length,

      availableNow:
        fleet.filter(
          (c) =>
            c.availableNow,
        ).length,

      bookedNow:
        fleet.filter(
          (c) =>
            c.bookedNow,
        ).length,

      carsWithBookings,

      carsWithoutBookings,

      utilizationRate,
    },

    metrics: {
      totalBookings:
        bookings.length,

      activeBookings:
        activeBookings.length,

      completedBookings:
        completed.length,

      cancelledBookings:
        cancelled.length,

      revenue:
        roundMoney(revenue),

      ownerRevenue:
        roundMoney(
          ownerRevenue,
        ),

      averageBookingValue,

      totalBookingDays:
        bookings.reduce(
          (sum, booking) =>
            sum +
            getBookingDays(
              booking,
            ),
          0,
        ),
    },

    pricingSignals,

    cars: fleet,

    bookings:
      bookings
        .slice(0, 150)
        .map((b) => ({
          id: b.id,

          bookingNumber:
            b.bookingNumber ||
            null,

          carId:
            getBookingCarId(b),

          carName:
            b.carName ||
            null,

          status:
            b.status ||
            null,

          days:
            getBookingDays(b),

          total:
            number(
              b.total,
              0,
            ),

          ownerEarning:
            number(
              b.ownerEarning ??
                b.ownerRevenue ??
                0,
              0,
            ),

          pickup:
            getBookingStart(b),

          returnDate:
            getBookingEnd(b),

          paymentStatus:
            b.paymentStatus ||
            null,

          created:
            b.created ||
            null,
        })),
  };
}

/* =========================================================
   ADMIN CONTEXT
========================================================= */

async function buildAdminContext(
  pb,
) {
  const [
    users,
    cars,
    bookings,
    businesses,
    disputes,
    verificationRequests,
  ] = await Promise.all([
    listSafe(
      pb,
      'users',
      {
        sort: '-created',
      },
    ),

    listSafe(
      pb,
      'cars',
      {
        sort: '-created',
      },
    ),

    listSafe(
      pb,
      'rydo_bookings_v2',
      {
        sort: '-created',
      },
    ),

    listSafe(
      pb,
      'business_profiles',
      {
        sort: '-created',
      },
    ),

    listSafe(
      pb,
      'disputes',
      {
        sort: '-created',
      },
    ),

    listSafe(
      pb,
      'verification_requests',
      {
        sort: '-created',
      },
    ),
  ]);

  const userItems =
    users.items;

  const carItems =
    cars.items;

  const bookingItems =
    bookings.items;

  const businessItems =
    businesses.items;

  const disputeItems =
    disputes.items;

  const verificationItems =
    verificationRequests.items;

  const completedBookings =
    bookingItems.filter(
      (b) =>
        isCompletedBooking(
          b.status,
        ),
    );

  const pendingBookings =
    bookingItems.filter(
      (b) =>
        lower(b.status) ===
        'pending',
    );

  const activeBookings =
    bookingItems.filter(
      (b) =>
        isBlockingBookingStatus(
          b.status,
        ) &&
        lower(b.status) !==
          'pending',
    );

  const cancelledBookings =
    bookingItems.filter(
      (b) =>
        isCancelledBooking(
          b.status,
        ),
    );

  const totalRevenue =
    completedBookings.reduce(
      (sum, booking) =>
        sum +
        number(
          booking.total,
          0,
        ),
      0,
    );

  const ownerRevenue =
    completedBookings.reduce(
      (sum, booking) =>
        sum +
        number(
          booking.ownerEarning ??
            booking.ownerRevenue ??
            0,
          0,
        ),
      0,
    );

  const commission =
    completedBookings.reduce(
      (sum, booking) => {
        const total =
          number(
            booking.total,
            0,
          );

        const owner =
          number(
            booking.ownerEarning ??
              booking.ownerRevenue ??
              0,
            0,
          );

        if (
          owner > 0 &&
          total >= owner
        ) {
          return (
            sum +
            (total - owner)
          );
        }

        return sum;
      },
      0,
    );

  const pendingBusinesses =
    businessItems.filter(
      (b) =>
        lower(b.status) ===
        'pending',
    );

  const approvedBusinesses =
    businessItems.filter(
      (b) =>
        lower(b.status) ===
        'approved',
    );

  const pendingVerification =
    verificationItems.filter(
      (v) =>
        [
          'pending',
          'submitted',
          'under_review',
        ].includes(
          lower(v.status),
        ),
    );

  const carStatus =
    carItems.reduce(
      (acc, car) => {
        const key =
          lower(car.status) ||
          'unknown';

        acc[key] =
          (acc[key] || 0) + 1;

        return acc;
      },
      {},
    );

  const businessStatuses =
    businessItems.reduce(
      (acc, business) => {
        const key =
          lower(
            business.status,
          ) ||
          'unknown';

        acc[key] =
          (acc[key] || 0) + 1;

        return acc;
      },
      {},
    );

  const fleetAvailability =
    carItems.map((car) => {
      const state =
        getCarBookingState(
          car,
          bookingItems,
        );

      return {
        id: car.id,

        name:
          car.name ||
          `${car.brand || ''} ${
            car.model || ''
          }`.trim(),

        status:
          car.status,

        availableNow:
          state.availableNow,

        bookedNow:
          state.bookedNow,
      };
    });

  return {
    user: {
      role: 'admin',
    },

    counts: {
      users:
        userItems.length,

      cars:
        carItems.length,

      activeCars:
        carItems.filter(
          (c) =>
            !isInactiveStatus(
              c.status,
            ),
        ).length,

      bookings:
        bookingItems.length,

      businesses:
        businessItems.length,

      approvedBusinesses:
        approvedBusinesses.length,

      disputes:
        disputeItems.length,

      verificationRequests:
        verificationItems.length,

      pendingVerification:
        pendingVerification.length,

      pendingBusinesses:
        pendingBusinesses.length,

      pendingBookings:
        pendingBookings.length,

      activeBookings:
        activeBookings.length,

      completedBookings:
        completedBookings.length,

      cancelledBookings:
        cancelledBookings.length,
    },

    revenue: {
      completedBookingRevenue:
        roundMoney(
          totalRevenue,
        ),

      ownerRevenue:
        roundMoney(
          ownerRevenue,
        ),

      estimatedCommission:
        roundMoney(
          commission,
        ),
    },

    carStatus,

    businessStatuses,

    fleetAvailability,

    recentBookings:
      bookingItems
        .slice(0, 75)
        .map((b) => ({
          id: b.id,

          bookingNumber:
            b.bookingNumber ||
            null,

          status:
            b.status ||
            null,

          total:
            number(
              b.total,
              0,
            ),

          carName:
            b.carName ||
            null,

          ownerId:
            b.ownerId ||
            null,

          clientId:
            b.clientId ||
            null,

          created:
            b.created ||
            null,
        })),

    recentDisputes:
      disputeItems
        .slice(0, 50)
        .map((d) => ({
          id: d.id,

          status:
            d.status ||
            null,

          type:
            d.type ||
            null,

          bookingId:
            d.bookingId ||
            null,

          created:
            d.created ||
            null,
        })),

    verificationRequests:
      verificationItems
        .slice(0, 50)
        .map((v) => ({
          id: v.id,

          status:
            v.status ||
            null,

          userId:
            v.userId ||
            v.ownerId ||
            null,

          created:
            v.created ||
            null,
        })),
  };
}

/* =========================================================
   COMPLETE CONTEXT
========================================================= */

async function buildContext(
  pb,
  user,
  role,
  businessApproved,
) {
  const [
    allCars,
    allBookings,
  ] = await Promise.all([
    listSafe(
      pb,
      'cars',
      {
        sort: '-created',
      },
    ),

    listSafe(
      pb,
      'rydo_bookings_v2',
      {
        sort: '-created',
      },
    ),
  ]);

  const common = {
    platform:
      getRydoPlatformKnowledge(),

    generatedAt:
      new Date().toISOString(),

    authenticatedRole:
      role,

    businessApproved,
  };

  if (role === 'client') {
    const client =
      await buildClientContext(
        pb,
        user,
        allBookings.items,
        allCars.items,
      );

    return {
      ...common,
      ...client,
    };
  }

  if (
    role === 'owner' ||
    role === 'business'
  ) {
    const owner =
      await buildOwnerContext(
        pb,
        user,
        role,
        allCars.items,
        allBookings.items,
      );

    return {
      ...common,
      ...owner,
    };
  }

  const admin =
    await buildAdminContext(
      pb,
    );

  return {
    ...common,
    ...admin,
  };
}

/* =========================================================
   AI CAR RECOMMENDATION PARSER
========================================================= */

function parseAIRecommendation(
  content,
  role,
  context,
) {
  const raw =
    String(content || '');

  const markerRegex =
    /\[\[RYDO_RECOMMENDATION\]\]([\s\S]*?)\[\[\/RYDO_RECOMMENDATION\]\]/i;

  const match =
    raw.match(markerRegex);

  const cleanContent =
    raw
      .replace(
        markerRegex,
        '',
      )
      .trim();

  if (
    role !== 'client' ||
    !match
  ) {
    return {
      content: cleanContent,
      recommendation: null,
    };
  }

  let parsed = null;

  try {
    parsed = JSON.parse(
      match[1].trim(),
    );
  } catch (error) {
    console.error(
      'RYDO AI recommendation JSON error:',
      error?.message ||
        error,
    );

    return {
      content: cleanContent,
      recommendation: null,
    };
  }

  const availableCars =
    Array.isArray(
      context?.availableCars,
    )
      ? context.availableCars
      : [];

  const requestedCarId =
    text(parsed?.carId);

  if (!requestedCarId) {
    return {
      content: cleanContent,
      recommendation: null,
    };
  }

  const car =
    availableCars.find(
      (item) =>
        String(item.id) ===
        requestedCarId,
    );

  if (!car) {
    console.warn(
      `RYDO AI tried to recommend unknown carId: ${requestedCarId}`,
    );

    return {
      content: cleanContent,
      recommendation: null,
    };
  }

  const parsedPrice =
    Number(parsed?.price);

  const price =
    Number.isFinite(
      parsedPrice,
    )
      ? parsedPrice
      : getDailyPrice(car);

  const title =
    text(parsed?.title) ||
    text(car.name) ||
    `${text(car.brand)} ${text(
      car.model,
    )}`.trim() ||
    'RYDO Car';

  const reason =
    text(parsed?.reason) ||
    'Kjo veturë përputhet mirë me kërkesën tënde.';

  return {
    content: cleanContent,

    recommendation: {
      type: 'car',

      carId:
        String(car.id),

      title,

      reason,

      price:
        roundMoney(price),

      currency:
        'EUR',

      image:
        getCarImageUrl(car),

      brand:
        car.brand || null,

      model:
        car.model || null,

      year:
        car.year || null,

      transmission:
        car.transmission || null,

      fuel:
        car.fuel || null,

      seats:
        car.seats || null,

      city:
        car.city || null,

      location:
        car.location || null,

      availableNow:
        Boolean(
          car.availableNow,
        ),
    },
  };
}

/* =========================================================
   PROMOTION PLAN HELPERS
========================================================= */

function clampNumber(
  value,
  min,
  max,
) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Math.min(
    Math.max(n, min),
    max,
  );
}

function sanitizePromotionPrice(
  value,
  fallback,
) {
  const parsed =
    Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return fallback > 0
      ? roundMoney(fallback)
      : null;
  }

  return roundMoney(parsed);
}

function sanitizePromotionPlan(
  plan,
  car,
  fallbackName,
) {
  const allowedNames = [
    'Conservative',
    'Balanced',
    'Aggressive',
  ];

  const rawName =
    text(plan?.name);

  const name =
    allowedNames.includes(
      rawName,
    )
      ? rawName
      : fallbackName;

  const currentDaily =
    getDailyPrice(car);

  const current3to6 =
    getPrice3to6(car);

  const current7to29 =
    getPrice7to29(car);

  const currentWeekend =
    getWeekendPrice(car);

  const currentMonthly =
    getMonthlyPrice(car);

  const dailyPrice =
    sanitizePromotionPrice(
      plan?.dailyPrice,
      currentDaily,
    );

  const price3to6 =
    sanitizePromotionPrice(
      plan?.price3to6,
      current3to6 ||
        dailyPrice ||
        currentDaily,
    );

  const price7to29 =
    sanitizePromotionPrice(
      plan?.price7to29,
      current7to29 ||
        price3to6 ||
        dailyPrice ||
        currentDaily,
    );

  const weekendPrice =
    sanitizePromotionPrice(
      plan?.weekendPrice,
      currentWeekend ||
        dailyPrice ||
        currentDaily,
    );

  const monthlyPrice =
    sanitizePromotionPrice(
      plan?.monthlyPrice,
      currentMonthly,
    );

  let discountPercent =
    clampNumber(
      plan?.discountPercent,
      0,
      80,
    );

  if (
    discountPercent === null &&
    currentDaily > 0 &&
    dailyPrice !== null
  ) {
    discountPercent =
      roundMoney(
        Math.max(
          0,
          Math.min(
            80,
            ((currentDaily -
              dailyPrice) /
              currentDaily) *
              100,
          ),
        ),
      );
  }

  if (
    discountPercent === null
  ) {
    discountPercent = 0;
  }

  const durationDays =
    clampNumber(
      plan?.durationDays,
      1,
      365,
    );

  return {
    id:
      `${name.toLowerCase()}`,

    carId:
      String(car.id),

    carTitle:
      text(car.name) ||
      `${text(car.brand)} ${text(
        car.model,
      )}`.trim() ||
      'RYDO Car',

    name,

    recommended:
      Boolean(
        plan?.recommended,
      ),

    dailyPrice,

    price3to6,

    price7to29,

    weekendPrice,

    monthlyPrice,

    discountPercent:
      roundMoney(
        discountPercent,
      ),

    durationDays:
      durationDays === null
        ? null
        : Math.round(
            durationDays,
          ),

    reason:
      text(plan?.reason) ||
      'Ky plan synon ta bëjë ofertën më konkurruese.',

    tradeoff:
      text(plan?.tradeoff) ||
      'Mund të ulë të ardhurat për ditë në këmbim të mundësisë për më shumë rezervime.',
  };
}

function parseAIPromotionPlans(
  content,
  role,
  context,
) {
  const raw =
    String(content || '');

  const markerRegex =
    /\[\[RYDO_PROMOTION_PLANS\]\]([\s\S]*?)\[\[\/RYDO_PROMOTION_PLANS\]\]/i;

  const match =
    raw.match(markerRegex);

  const cleanContent =
    raw
      .replace(
        markerRegex,
        '',
      )
      .trim();

  if (
    !(
      role === 'owner' ||
      role === 'business'
    ) ||
    !match
  ) {
    return {
      content: cleanContent,
      promotionPlans: null,
    };
  }

  let parsed = null;

  try {
    parsed = JSON.parse(
      match[1].trim(),
    );
  } catch (error) {
    console.error(
      'RYDO AI promotion JSON error:',
      error?.message ||
        error,
    );

    return {
      content: cleanContent,
      promotionPlans: null,
    };
  }

  const fleet =
    Array.isArray(
      context?.cars,
    )
      ? context.cars
      : [];

  const requestedCarId =
    text(parsed?.carId);

  if (!requestedCarId) {
    return {
      content: cleanContent,
      promotionPlans: null,
    };
  }

  const car =
    fleet.find(
      (item) =>
        String(item.id) ===
        requestedCarId,
    );

  if (!car) {
    console.warn(
      `RYDO AI tried to create promotion plan for unknown carId: ${requestedCarId}`,
    );

    return {
      content: cleanContent,
      promotionPlans: null,
    };
  }

  const rawPlans =
    Array.isArray(
      parsed?.plans,
    )
      ? parsed.plans
      : [];

  if (
    rawPlans.length === 0
  ) {
    return {
      content: cleanContent,
      promotionPlans: null,
    };
  }

  const fallbackNames = [
    'Conservative',
    'Balanced',
    'Aggressive',
  ];

  const plans = fallbackNames.map(
    (name) => {
      const matchingPlan =
        rawPlans.find(
          (plan) =>
            lower(
              plan?.name,
            ) ===
            lower(name),
        ) ||
        rawPlans.find(
          (plan) =>
            text(plan?.id) ===
            name.toLowerCase(),
        );

      return sanitizePromotionPlan(
        matchingPlan || {},
        car,
        name,
      );
    },
  );

  let recommendedIndex =
    plans.findIndex(
      (plan) =>
        plan.recommended,
    );

  if (
    recommendedIndex < 0
  ) {
    recommendedIndex = 1;
  }

  const normalizedPlans =
    plans.map(
      (plan, index) => ({
        ...plan,
        recommended:
          index ===
          recommendedIndex,
      }),
    );

  const carTitle =
    text(car.name) ||
    `${text(car.brand)} ${text(
      car.model,
    )}`.trim() ||
    'RYDO Car';

  return {
    content: cleanContent,

    promotionPlans: {
      carId:
        String(car.id),

      carTitle,

      recommendationReason:
        text(
          parsed?.recommendationReason,
        ) ||
        'Ky plan bazohet në çmimin aktual, historikun e rezervimeve, disponueshmërinë dhe mundësinë për të rritur rezervimet.',

      plans:
        normalizedPlans,
    },
  };
}

/* =========================================================
   ROLE-SPECIFIC AI INSTRUCTIONS
========================================================= */

function instructionsFor(role) {
  const base = `
You are RYDO AI, the official AI assistant inside the RYDO platform.

RYDO operates in Kosovo and provides car rental and related mobility services.

You are not just a chatbot.

Your three responsibilities are:

1. ASSISTANT
Explain what is happening and answer the user's question.

2. HELPER
Tell the user what they can do next inside RYDO.

3. RECOMMENDER
Use live RYDO data to recommend the best next action.

Always try to be useful.

LANGUAGE:

Reply in the same language as the user.

If the user writes Albanian or Kosovar Albanian, answer in natural Albanian used in Kosovo.

Do not unnecessarily switch to English.

STYLE:

Be clear.

Be practical.

Be direct.

Do not write extremely long answers unless the user asks for detail.

When recommendations are useful, use short bullet points.

Do not use fake certainty.

LIVE DATA:

The supplied RYDO context is the source of truth for live platform data.

Never invent:

- cars
- prices
- availability
- bookings
- users
- revenue
- commission
- verification status
- disputes
- wallet balances
- RYDO Points

If data is missing, say that the live data does not contain enough information.

PRIVACY:

Only discuss data that the authenticated user is allowed to see.

A client can see their own private booking, wallet and points information.

An owner can see their own fleet and bookings.

A business user can see their own business and fleet.

An admin can see platform-level information.

Never expose private information from another user.

BOOKING AVAILABILITY:

Never assume that an active car is automatically available.

Use:

availableNow

bookedNow

scheduledBookings

If the user gives future dates, check scheduledBookings for overlapping bookings whenever the data allows it.

If the requested dates are unclear, ask for exact pickup and return date/time.

PRICING:

Use actual RYDO pricing fields.

Available fields can include:

dailyPrice

price

price3to6

price7to29

weekendPrice

monthlyPrice

Never invent an exact current vehicle price when the data does not contain it.

PROMOTIONS:

When the user asks for a promotion plan, do not just give generic marketing advice.

First analyze:

- cars with no bookings
- cars with weak booking history
- cars with strong booking history
- current prices
- available cars
- booking volume
- completed bookings
- booking days
- vehicle utilization

Then recommend which car should be promoted.

When the user asks something like:

"Zgjedhma cili plan ma i mir"

"cili plan është më i mirë"

"ma bëj një promotion plan"

"si me e promovu këtë veturë"

"çfarë zbritje me i bo"

you should create THREE concrete plans for the best live vehicle candidate:

1. Conservative
2. Balanced
3. Aggressive

The Balanced plan should normally be the recommended plan when it provides the best balance between booking growth and revenue.

However, use live data to choose the recommended plan.

Exactly ONE plan must have:

"recommended": true

The other two must have:

"recommended": false

Each plan MUST contain:

- vehicle
- plan name
- daily price
- 3-6 day price
- 7-29 day price
- weekend price when relevant
- monthly price when relevant
- discount percentage
- duration in days
- reason
- tradeoff

The prices must be based on the live vehicle pricing and booking data.

Do not invent a vehicle ID.

Do not invent a vehicle that is not in the live context.

The promotion is only a recommendation.

Do not claim that it has been activated.

The owner/business user must review the values and save them manually in the vehicle edit screen.

PROMOTION PLAN MACHINE FORMAT:

For OWNER or BUSINESS users, when you create three concrete promotion plans, append this machine-readable block:

[[RYDO_PROMOTION_PLANS]]

{
  "carId":"EXACT_LIVE_CAR_ID",
  "carTitle":"Exact live car title",
  "recommendationReason":"Why this vehicle is the best candidate",
  "plans":[
    {
      "id":"conservative",
      "name":"Conservative",
      "recommended":false,
      "dailyPrice":45,
      "price3to6":43,
      "price7to29":40,
      "weekendPrice":47,
      "monthlyPrice":1100,
      "discountPercent":10,
      "durationDays":14,
      "reason":"Reason",
      "tradeoff":"Tradeoff"
    },
    {
      "id":"balanced",
      "name":"Balanced",
      "recommended":true,
      "dailyPrice":43,
      "price3to6":41,
      "price7to29":38,
      "weekendPrice":45,
      "monthlyPrice":1050,
      "discountPercent":14,
      "durationDays":14,
      "reason":"Reason",
      "tradeoff":"Tradeoff"
    },
    {
      "id":"aggressive",
      "name":"Aggressive",
      "recommended":false,
      "dailyPrice":39,
      "price3to6":37,
      "price7to29":34,
      "weekendPrice":41,
      "monthlyPrice":990,
      "discountPercent":22,
      "durationDays":21,
      "reason":"Reason",
      "tradeoff":"Tradeoff"
    }
  ]
}

Rules:

1. carId MUST exactly match a real live car ID from the authenticated owner's/business fleet.

2. Never invent a carId.

3. Never create fake URLs.

4. Always create exactly three plans when a promotion plan is requested and enough live data exists.

5. The names must be exactly:
   Conservative
   Balanced
   Aggressive

6. Exactly one plan must have recommended=true.

7. The three plans should have meaningfully different risk/reward levels.

8. Prices should be realistic relative to the vehicle's current prices.

9. Do not claim the prices have already been changed.

10. Do not claim the promotion has been activated.

11. Do not put Markdown code fences around the machine-readable block.

12. The server validates the carId and removes this block before the final response reaches the app.

13. The visible answer should still explain which plan is recommended.

PRICING RECOMMENDATIONS:

When asked whether prices should change:

1. Analyze booking history.

2. Analyze current price.

3. Analyze availability.

4. Analyze utilization.

5. Give a recommended direction.

For example:

- increase price
- decrease price
- keep price
- create long-rental discount
- create weekend price

Clearly say this is a recommendation.

ACTIONS:

You currently cannot directly:

- create a booking
- cancel a booking
- refund money
- approve verification
- delete a vehicle
- change prices
- activate promotions
- transfer money
- modify accounts

Do not pretend to have completed these actions.

Instead tell the user which RYDO screen/action should be used.

RYDO FEATURES:

Use the supplied platform knowledge to explain the application.

When a user asks "si bëhet", explain the relevant RYDO workflow.

When appropriate, recommend the relevant app area such as:

- Explore
- Cars
- Booking
- Profile
- Wallet
- Owner Dashboard
- Business Profile
- Admin Dashboard

Do not claim a UI action exists if the supplied platform knowledge does not support it.

=========================================================
CAR RECOMMENDATION CARD
=========================================================

When the authenticated role is CLIENT and you recommend ONE specific car as the best choice, you MUST append:

[[RYDO_RECOMMENDATION]]

{"carId":"EXACT_LIVE_CAR_ID","title":"Car name","reason":"Short reason why this car is recommended","price":45}

[[/RYDO_RECOMMENDATION]]

Rules:

1. carId MUST exactly match a real car id from live availableCars data.

2. NEVER invent a carId.

3. NEVER create a fake URL.

4. The app will turn the carId into a real clickable car recommendation.

5. Prefer cars that match the user's:

- budget
- requested dates
- transmission
- fuel
- seats
- location
- delivery preference
- other stated preferences

6. If the user asks for the best available car, choose from live cars.

7. If a specific car is requested, recommend that car only if it exists in live data.

8. If no suitable car exists, do not output the recommendation block.

9. If the user asks to compare multiple cars, explain the comparison normally.

10. Do not put Markdown code fences around the recommendation block.

11. Do not show the recommendation block as visible text.

12. The server validates the carId and removes this block before the final response reaches the app.
`;

  const roles = {
    client: `
ROLE: CLIENT

You are the personal rental assistant for the authenticated RYDO client.

Focus on:

- finding cars
- comparing cars
- availability
- rental dates
- prices
- booking status
- payment status
- deposits
- wallet
- RYDO Points
- pickup
- delivery
- airport pickup
- reviews
- choosing the best car

When recommending a car, consider:

- availability
- price
- vehicle details
- transmission
- fuel
- seats
- location
- delivery availability

Do not expose another client's private information.
`,

    owner: `
ROLE: OWNER

You are the business assistant for an individual RYDO vehicle owner.

Focus on:

- fleet
- vehicle availability
- bookings
- earnings
- revenue
- pricing
- promotions
- utilization
- listings
- photos
- descriptions
- delivery
- business growth

When analyzing the fleet:

Identify:

- strongest vehicles
- weakest vehicles
- cars without bookings
- cars with strong booking history
- available vehicles
- currently booked vehicles
- pricing opportunities

When asked:

"Zgjedhma cili plan ma i mir"

you must use the live fleet data and create the three promotion plans described in the promotion plan machine format.

Do not expose another owner's data.
`,

    business: `
ROLE: BUSINESS

You are the RYDO Business AI for an approved business profile.

Think like a fleet manager and business consultant.

Focus on:

- fleet utilization
- revenue
- bookings
- average booking value
- vehicle performance
- pricing
- promotions
- business profile
- growth
- operational efficiency

When asked for a report, summarize the important metrics first.

When asked for a growth plan, create practical steps.

When asked for promotion:

Identify the best vehicle to promote based on live booking and utilization data.

Then create three concrete plans:

- Conservative
- Balanced
- Aggressive

Exactly one must be recommended.

When asked about pricing:

Give vehicle-specific recommendations where enough data exists.

Do not expose another business owner's private data.
`,

    admin: `
ROLE: ADMIN

You are the RYDO Admin AI.

Think like a platform operations analyst.

Focus on:

- users
- cars
- bookings
- business profiles
- verification
- disputes
- platform revenue
- commission
- operational problems
- growth
- fleet health

Prioritize issues.

When asked "what should I review first?", rank issues by urgency.

For platform health consider:

- pending bookings
- active bookings
- cancelled bookings
- inactive cars
- pending businesses
- pending verification
- disputes
- revenue
- commission
- active fleet

Avoid exposing unnecessary personal information.
`,
  };

  return (
    base +
    (roles[role] ||
      roles.client)
  );
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/health',
  (_req, res) => {
    res.json({
      ok: true,
      service: 'rydo-ai',
      provider: 'openrouter',
      model: MODEL,
      pocketbaseConfigured:
        Boolean(PB_URL),
    });
  },
);

/* =========================================================
   PROMOTION INTENT
========================================================= */

function isPromotionIntent(message) {
  const raw = lower(message);

  return (
    /\b(promov|promoc|zbrit|ulje|ofert|discount|promotion|promote)\b/i.test(
      raw,
    ) ||
    /cili\s+plan/i.test(raw) ||
    /plan.*(mir|mire|miri|best)/i.test(raw) ||
    /ma\s+i\s+mir/i.test(raw)
  );
}

/* =========================================================
   FALLBACK PROMOTION ENGINE
========================================================= */

function getPromotionCandidateScore(car) {
  let score = 0;

  if (car.availableNow) {
    score += 30;
  }

  if (!car.bookedNow) {
    score += 15;
  }

  if (car.bookings === 0) {
    score += 40;
  } else if (car.bookings <= 2) {
    score += 25;
  } else if (car.bookings <= 4) {
    score += 10;
  }

  if (car.completedBookings === 0) {
    score += 20;
  }

  if (car.dailyPrice > 0 && car.dailyPrice >= 60) {
    score += 10;
  }

  if (car.dailyPrice > 0 && car.dailyPrice < 30) {
    score -= 10;
  }

  if (isInactiveStatus(car.status)) {
    score -= 100;
  }

  return score;
}

function choosePromotionCandidate(context) {
  const fleet = Array.isArray(context?.cars)
    ? context.cars
    : [];

  const candidates = fleet
    .filter((car) => {
      return (
        car &&
        car.id &&
        !isInactiveStatus(car.status) &&
        number(car.dailyPrice, 0) > 0
      );
    })
    .map((car) => ({
      car,
      score: getPromotionCandidateScore(car),
    }))
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.car || null;
}

function calculateDiscountPercent(original, promoted) {
  const oldPrice = number(original, 0);
  const newPrice = number(promoted, 0);

  if (
    oldPrice <= 0 ||
    newPrice <= 0 ||
    newPrice >= oldPrice
  ) {
    return 0;
  }

  return roundMoney(
    Math.max(
      0,
      Math.min(
        80,
        ((oldPrice - newPrice) / oldPrice) * 100,
      ),
    ),
  );
}

function createFallbackPromotionPlans(car) {
  const currentDaily = getDailyPrice(car);

  if (currentDaily <= 0) {
    return null;
  }

  const current3to6 =
    getPrice3to6(car) > 0
      ? getPrice3to6(car)
      : currentDaily;

  const current7to29 =
    getPrice7to29(car) > 0
      ? getPrice7to29(car)
      : currentDaily;

  const currentWeekend =
    getWeekendPrice(car) > 0
      ? getWeekendPrice(car)
      : currentDaily;

  const currentMonthly =
    getMonthlyPrice(car) > 0
      ? getMonthlyPrice(car)
      : roundMoney(currentDaily * 30);

  /*
   * Conservative
   * Small discount, short test.
   */
  const conservativeDaily = roundMoney(
    currentDaily * 0.95,
  );

  const conservative3to6 = roundMoney(
    current3to6 * 0.95,
  );

  const conservative7to29 = roundMoney(
    current7to29 * 0.95,
  );

  const conservativeWeekend = roundMoney(
    currentWeekend * 0.97,
  );

  const conservativeMonthly = roundMoney(
    currentMonthly * 0.97,
  );

  /*
   * Balanced
   * Moderate discount and enough time to measure results.
   */
  const balancedDaily = roundMoney(
    currentDaily * 0.90,
  );

  const balanced3to6 = roundMoney(
    current3to6 * 0.90,
  );

  const balanced7to29 = roundMoney(
    current7to29 * 0.88,
  );

  const balancedWeekend = roundMoney(
    currentWeekend * 0.93,
  );

  const balancedMonthly = roundMoney(
    currentMonthly * 0.94,
  );

  /*
   * Aggressive
   * Bigger discount to prioritize bookings.
   */
  const aggressiveDaily = roundMoney(
    currentDaily * 0.85,
  );

  const aggressive3to6 = roundMoney(
    current3to6 * 0.85,
  );

  const aggressive7to29 = roundMoney(
    current7to29 * 0.82,
  );

  const aggressiveWeekend = roundMoney(
    currentWeekend * 0.88,
  );

  const aggressiveMonthly = roundMoney(
    currentMonthly * 0.90,
  );

  const carTitle =
    text(car.name) ||
    `${text(car.brand)} ${text(car.model)}`.trim() ||
    'RYDO Car';

  return {
    carId: String(car.id),

    carTitle,

    recommendationReason:
      car.bookings === 0
        ? `Kjo veturë nuk ka histori rezervimesh dhe është e disponueshme. Promovimi i saj ka prioritet më të lartë për të gjeneruar rezervimin e parë.`
        : car.completedBookings === 0
          ? `Kjo veturë ka pasur interes, por nuk ka rezervime të përfunduara. Një ofertë e kontrolluar mund të ndihmojë në kthimin e interesit në rezervime.`
          : `Kjo veturë ka nevojë për një ofertë të kontrolluar për të rritur rezervimet pa ulur shumë të ardhurat për ditë.`,

    plans: [
      {
        id: 'conservative',
        carId: String(car.id),
        carTitle,
        name: 'Conservative',
        recommended: false,

        dailyPrice: conservativeDaily,
        price3to6: conservative3to6,
        price7to29: conservative7to29,
        weekendPrice: conservativeWeekend,
        monthlyPrice: conservativeMonthly,

        discountPercent:
          calculateDiscountPercent(
            currentDaily,
            conservativeDaily,
          ),

        durationDays: 14,

        reason:
          'Zbritje e vogël për ta testuar reagimin e klientëve pa ulur shumë marzhin.',
        tradeoff:
          'Rreziku është më i ulët, por mund të sjellë më pak rezervime sesa një ofertë më agresive.',
      },

      {
        id: 'balanced',
        carId: String(car.id),
        carTitle,
        name: 'Balanced',
        recommended: true,

        dailyPrice: balancedDaily,
        price3to6: balanced3to6,
        price7to29: balanced7to29,
        weekendPrice: balancedWeekend,
        monthlyPrice: balancedMonthly,

        discountPercent:
          calculateDiscountPercent(
            currentDaily,
            balancedDaily,
          ),

        durationDays: 21,

        reason:
          'Ky është kompromisi më i mirë mes një çmimi konkurrues dhe ruajtjes së të ardhurave.',
        tradeoff:
          'Të ardhurat për ditë bien pak, por oferta ka më shumë potencial për të rritur numrin e rezervimeve.',
      },

      {
        id: 'aggressive',
        carId: String(car.id),
        carTitle,
        name: 'Aggressive',
        recommended: false,

        dailyPrice: aggressiveDaily,
        price3to6: aggressive3to6,
        price7to29: aggressive7to29,
        weekendPrice: aggressiveWeekend,
        monthlyPrice: aggressiveMonthly,

        discountPercent:
          calculateDiscountPercent(
            currentDaily,
            aggressiveDaily,
          ),

        durationDays: 30,

        reason:
          'Zbritje më e madhe për ta bërë veturën shumë konkurruese dhe për të prioritizuar rezervimet.',
        tradeoff:
          'Mund të sjellë më shumë rezervime, por ul më shumë të ardhurat për ditë.',
      },
    ],
  };
}

/* =========================================================
   OPENROUTER CONTENT EXTRACTION
========================================================= */

function extractOpenRouterContent(completion) {
  const message =
    completion?.choices?.[0]?.message;

  if (!message) {
    return '';
  }

  if (
    typeof message.content === 'string' &&
    message.content.trim()
  ) {
    return message.content.trim();
  }

  /*
   * Some OpenRouter models can return reasoning
   * without normal content.
   *
   * We do NOT expose reasoning to the user.
   */
  return '';
}

/* =========================================================
   AI CHAT
========================================================= */

app.post(
  '/v1/ai/chat',
  async (req, res) => {
    try {
      if (
        !process.env.OPENROUTER_API_KEY
      ) {
        return res
          .status(503)
          .json({
            error:
              'RYDO AI server has no OPENROUTER_API_KEY configured.',
          });
      }

      if (!PB_URL) {
        return res
          .status(503)
          .json({
            error:
              'RYDO AI server has no POCKETBASE_URL configured.',
          });
      }

      const message = String(
        req.body?.message || '',
      ).trim();

      if (!message) {
        return res
          .status(400)
          .json({
            error:
              'Message is required.',
          });
      }

      if (message.length > 2000) {
        return res
          .status(400)
          .json({
            error:
              'Message is too long.',
          });
      }

      const {
        pb,
        user,
      } =
        await getAuthenticatedUser(req);

      const businessApproved =
        await getBusinessStatus(
          pb,
          user.id,
        );

      const role =
        resolveRole(
          user,
          businessApproved,
        );

      console.log(
        `RYDO AI request: user=${user.id} role=${role}`,
      );

      const context =
        await buildContext(
          pb,
          user,
          role,
          businessApproved,
        );

      const history =
        cleanHistory(
          req.body?.history,
        );

      const liveContext = `
AUTHENTICATED RYDO USER

Role: ${role}

Business approved: ${businessApproved}

CURRENT LIVE RYDO CONTEXT

${JSON.stringify(
  context,
  null,
  2,
)}
`;

      const messages = [
        {
          role: 'system',
          content:
            instructionsFor(
              role,
            ),
        },

        {
          role: 'system',
          content:
            liveContext,
        },

        ...history,

        {
          role: 'user',
          content: message,
        },
      ];

      let content = '';

      try {
        const completion =
          await openrouter.chat.completions.create(
            {
              model: MODEL,
              messages,
              temperature: 0.2,
              max_tokens: 2200,
            },
          );

        content =
          extractOpenRouterContent(
            completion,
          );

        if (!content) {
          console.warn(
            'OpenRouter returned empty content.',
          );
        }
      } catch (openRouterError) {
        console.error(
          'OpenRouter request error:',
          openRouterError?.message ||
            openRouterError,
        );
      }

      /*
       * =====================================================
       * LIVE POCKETBASE FALLBACK
       * =====================================================
       *
       * If the user asks for a promotion and OpenRouter
       * returns no content, we still create a real plan
       * from the authenticated owner's/business fleet.
       */

      if (
        !content &&
        isPromotionIntent(message) &&
        (role === 'owner' ||
          role === 'business')
      ) {
        const candidate =
          choosePromotionCandidate(
            context,
          );

        const fallbackPlans =
          candidate
            ? createFallbackPromotionPlans(
                candidate,
              )
            : null;

        if (fallbackPlans) {
          console.log(
            'RYDO AI promotion fallback:',
            fallbackPlans.carId,
          );

          return res.json({
            content:
              `E analizova flotën aktuale tënde dhe çmimet nga PocketBase. ` +
              `Veturën që do ta promovoja është **${fallbackPlans.carTitle}**.\n\n` +
              `${fallbackPlans.recommendationReason}\n\n` +
              `Nga tre opsionet, **Balanced** është zgjedhja ime e rekomanduar sepse balancon më mirë rritjen e rezervimeve me të ardhurat.`,
            recommendation:
              null,
            promotionPlans:
              fallbackPlans,
            role,
            businessApproved,
            model: MODEL,
            fallback: true,
          });
        }
      }

      /*
       * For normal questions, an empty response is still
       * treated as an actual provider failure.
       */
      if (!content) {
        throw new Error(
          'OpenRouter returned an empty response and no RYDO fallback was available.',
        );
      }

      /*
       * =====================================================
       * CLIENT CAR RECOMMENDATION
       * =====================================================
       */

      const recommendationResponse =
        parseAIRecommendation(
          String(content),
          role,
          context,
        );

      /*
       * =====================================================
       * OWNER/BUSINESS PROMOTION PLANS
       * =====================================================
       */

      const promotionResponse =
        parseAIPromotionPlans(
          recommendationResponse.content,
          role,
          context,
        );

      /*
       * =====================================================
       * SECOND FALLBACK
       * =====================================================
       *
       * If OpenRouter answered normally but forgot to
       * generate the machine-readable promotion block,
       * create the structured plans ourselves.
       */

      let finalPromotionPlans =
        promotionResponse.promotionPlans;

      let finalContent =
        promotionResponse.content;

      if (
        !finalPromotionPlans &&
        isPromotionIntent(message) &&
        (role === 'owner' ||
          role === 'business')
      ) {
        const candidate =
          choosePromotionCandidate(
            context,
          );

        const fallbackPlans =
          candidate
            ? createFallbackPromotionPlans(
                candidate,
              )
            : null;

        if (fallbackPlans) {
          finalPromotionPlans =
            fallbackPlans;

          const recommendationText =
            `\n\nE analizova edhe të dhënat live të flotës. ` +
            `Veturën **${fallbackPlans.carTitle}** do ta kisha prioritet për promovim. ` +
            `Nga tre opsionet, **Balanced** është zgjedhja e rekomanduar.`;

          finalContent =
            `${finalContent}${recommendationText}`.trim();
        }
      }

      console.log(
        'RYDO AI recommendation:',
        recommendationResponse.recommendation
          ? recommendationResponse
              .recommendation
              .carId
          : 'none',
      );

      console.log(
        'RYDO AI promotion plans:',
        finalPromotionPlans
          ? finalPromotionPlans.carId
          : 'none',
      );

      return res.json({
        content:
          finalContent,

        recommendation:
          recommendationResponse.recommendation,

        promotionPlans:
          finalPromotionPlans,

        role,

        businessApproved,

        model: MODEL,
      });
    } catch (error) {
      console.error(
        'RYDO AI ERROR:',
        error?.message ||
          error,
      );

      const status =
        error?.status ||
        error?.statusCode ||
        500;

      return res
        .status(
          status >= 400 &&
            status < 600
            ? status
            : 500,
        )
        .json({
          error:
            error?.message ||
            'RYDO AI request failed.',
        });
    }
  },
);

/* =========================================================
   SERVER
========================================================= */

const port = Number(
  process.env.PORT || 8787,
);

app.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `RYDO AI server listening on ${port}`,
    );

    console.log(
      'Provider: OpenRouter',
    );

    console.log(
      `Model: ${MODEL}`,
    );

    console.log(
      `PocketBase: ${
        PB_URL
          ? 'configured'
          : 'missing'
      }`,
    );
  },
);