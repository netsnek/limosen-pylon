// src/index.ts
import {app, auth, requireAuth} from '@getcronit/pylon'
// import { createBunWebSocket } from "hono/bun";

import { UserService } from "./user.service";
import { TransferService } from "./transfer.service";

export const graphql = {
  Query: {
    // Existing
    user: UserService.getZitadelUserById,
    getIsUnique: UserService.getIsUnique,
    getUserCount: UserService.getUserCount,
    getAllUser: UserService.listAllZitadelUsers,

    // NEW — roles / users by role
    getUsersByRole: UserService.listUsersByRole,
    getProjectRoles: UserService.listProjectRoles,

    // Transfers (read)
    getTransfer: TransferService.getTransfer,
    getAllTransfers: TransferService.listTransfers,
    getCustomerBookings: TransferService.getCustomerBookings,
    // NEW — driver-centric reads
    getDriverTransfers: TransferService.getDriverTransfers,
    getDriverRevenue: TransferService.getDriverRevenue
  },
  Mutation: {
    // Existing
    userCreate: UserService.userCreate,

    // NEW — user lifecycle
    deleteUser: UserService.deleteUser,
    deactivateUser: UserService.deactivateUser,
    reactivateUser: UserService.reactivateUser,
    lockUser: UserService.lockUser,
    unlockUser: UserService.unlockUser,

    // NEW — user updates (username/profile/email/phone/password)
    updateUser: UserService.updateUser,

    // NEW — credentials & verification
    setPassword: UserService.setPassword,
    requestPasswordReset: UserService.requestPasswordReset,
    sendEmailVerification: UserService.sendEmailVerification,
    resendEmailVerification: UserService.resendEmailVerification,
    verifyEmail: UserService.verifyEmail,
    setPhone: UserService.setPhone,

    // NEW — role/authorization management
    createAuthorization: UserService.createAuthorization,
    updateAuthorization: UserService.updateAuthorization,
    deleteAuthorization: UserService.deleteAuthorization,

    // NEW — project role management
    addProjectRole: UserService.addProjectRole,
    removeProjectRole: UserService.removeProjectRole,

    // Transfers (write)
    createTransfer: TransferService.createTransfer,
    bookTransfer: TransferService.bookTransfer,
    assignDriver: TransferService.assignDriver,
    // NEW — confirmed state
    markConfirmed: TransferService.markConfirmed,
    cancelTransfer: TransferService.cancelTransfer,
    terminateTransfer: TransferService.terminateTransfer,
    markCompleted: TransferService.markCompleted,

    // Maintenance
    syncMonthlyTransfers: TransferService.syncMonthlySheet
  }
};

app.use('*', auth.initialize());

export default app;
