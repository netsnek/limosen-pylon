// src/index.ts
import { app, auth } from "@getcronit/pylon";

import { UserService } from "./user.service";
import { TransferService } from "./transfer.service";
import { D1Service } from "./d1.service";
import { NotificationService } from "./notification.service";

export const graphql = {
  Query: {
    // ----------------------------
    // Users / roles (ZITADEL)
    // ----------------------------
    user: UserService.getZitadelUserById,
    getIsUnique: UserService.getIsUnique,
    getUserCount: UserService.getUserCount,
    getAllUser: UserService.listAllZitadelUsers,

    getUsersByRole: UserService.listUsersByRole,
    getProjectRoles: UserService.listProjectRoles,

    // ----------------------------
    // Transfers (Sheets) reads
    // ----------------------------
    getTransfer: TransferService.getTransfer,
    getAllTransfers: TransferService.listTransfers,
    getCustomerBookings: TransferService.getCustomerBookings,
    getDriverTransfers: TransferService.getDriverTransfers,
    getDriverRevenue: TransferService.getDriverRevenue,

    // ----------------------------
    // D1 / Prisma reads
    // ----------------------------
    getD1AllTransfers: D1Service.getD1AllTransfers,

    // ----------------------------
    // Notifications
    // ----------------------------
    getCurrentUserPushSubscriptions:
      NotificationService.getCurrentUserPushSubscriptions
  },

  Mutation: {
    // ----------------------------
    // Users / roles (ZITADEL)
    // ----------------------------
    userCreate: UserService.userCreate,

    deleteUser: UserService.deleteUser,
    deactivateUser: UserService.deactivateUser,
    reactivateUser: UserService.reactivateUser,
    lockUser: UserService.lockUser,
    unlockUser: UserService.unlockUser,

    updateUser: UserService.updateUser,

    setPassword: UserService.setPassword,
    requestPasswordReset: UserService.requestPasswordReset,
    sendEmailVerification: UserService.sendEmailVerification,
    resendEmailVerification: UserService.resendEmailVerification,
    verifyEmail: UserService.verifyEmail,
    setPhone: UserService.setPhone,

    createAuthorization: UserService.createAuthorization,
    updateAuthorization: UserService.updateAuthorization,
    deleteAuthorization: UserService.deleteAuthorization,

    addProjectRole: UserService.addProjectRole,
    removeProjectRole: UserService.removeProjectRole,

    // ----------------------------
    // Transfers (Sheets) writes
    // ----------------------------
    createTransfer: TransferService.createTransfer,
    bookTransfer: TransferService.bookTransfer,
    assignDriver: TransferService.assignDriver,
    assignPrice: TransferService.assignPrice,

    markConfirmed: TransferService.markConfirmed,
    cancelTransfer: TransferService.cancelTransfer,
    terminateTransfer: TransferService.terminateTransfer,
    markCompleted: TransferService.markCompleted,

    syncMonthlyTransfers: TransferService.syncMonthlySheet,

    // ----------------------------
    // D1 / Prisma writes
    // ----------------------------
    createD1Transfer: D1Service.createD1Transfer,

    // ----------------------------
    // Notifications
    // ----------------------------
    addCurrentUserPushSubscription:
      NotificationService.addCurrentUserPushSubscription,
    removeCurrentUserPushSubscription:
      NotificationService.removeCurrentUserPushSubscription,
    clearCurrentUserPushSubscriptions:
      NotificationService.clearCurrentUserPushSubscriptions,
    sendTestNotificationToCurrentUser:
      NotificationService.sendTestNotificationToCurrentUser
  }
};

app.use("*", auth.initialize());

export default app;
