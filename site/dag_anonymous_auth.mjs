export async function ensureAnonymousPublicationUser(client) {
  if (!client) throw new Error("Supabase is not configured.");

  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;

  const session = sessionData?.session;
  if (session?.access_token && session.user?.id) {
    const { data: userData, error: userError } = await client.auth.getUser();
    if (!userError && userData?.user?.id === session.user.id) return userData.user;
  }

  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  if (!data?.user?.id || !data?.session?.access_token) {
    throw new Error("Supabase did not create a valid anonymous session.");
  }
  return data.user;
}
