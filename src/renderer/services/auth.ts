import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  deleteUser,
  type User,
} from "firebase/auth";
import { doc, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "./firebase";

export type AppUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
};

export async function signup(name: string, email: string, password: string): Promise<AppUser> {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const user = credential.user;

  await updateProfile(user, { displayName: name });

  await setDoc(doc(db, "users", user.uid), {
    uid: user.uid,
    email: user.email,
    displayName: name,
    createdAt: serverTimestamp(),
  });

  return { uid: user.uid, email: user.email, displayName: name };
}

export async function login(email: string, password: string): Promise<AppUser> {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const user = credential.user;
  return { uid: user.uid, email: user.email, displayName: user.displayName };
}

export async function logout(): Promise<void> {
  await signOut(auth);
}

export function onAuthChange(callback: (user: AppUser | null) => void): () => void {
  return onAuthStateChanged(auth, (fbUser: User | null) => {
    if (fbUser) {
      callback({
        uid: fbUser.uid,
        email: fbUser.email,
        displayName: fbUser.displayName,
      });
    } else {
      callback(null);
    }
  });
}

/** Delete the current user's Firestore doc and Firebase Auth account. */
export async function deleteAccount(uid: string): Promise<void> {
  await deleteDoc(doc(db, "users", uid));
  const currentUser = auth.currentUser;
  if (currentUser) {
    await deleteUser(currentUser);
  }
}
