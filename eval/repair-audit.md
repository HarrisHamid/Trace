# Repair audit

**Status: awaiting human check.**

Each row is a claim that the validator marked unverified, and marked verified after repair. The validator only
proves the quote exists in that node's source. Only a person can say whether the quote proves the sentence.

For each row, read the sentence and the quote, then write yes or no in the last column:
**does this quote prove this sentence?** A true sentence with a quote that does not prove it is a no. A sentence
about what the agent did or did not read, such as "source was not fetched", is a no.

When you are done, change the status line above and tell whoever owns the eval how many were yes.

## The eval

| # | Question | Step | Sentence | Quote | Moved from | Proves it? |
|---|---|---|---|---|---|---|
| 1 | password-recovery-email (round-1) | `app.crud:get_user_by_email` | The lookup returns the user object or None if the email is not registered. | `def get_user_by_email(*, session: Session, email: str) -> User \| None:` |  |  |
| 2 | password-recovery-email (round-1) | `app.api.routes.login:recover_password` | Email is only sent if the user exists, otherwise a generic success message is returned. | `# Always return the same response to prevent email enumeration attacks # Only send email if user actually exists` |  |  |
| 3 | reset-password (round-1) | `app.api.routes.login:reset_password` | Looks up the user by the email decoded from the token. | `user = crud.get_user_by_email(session=session, email=email)` | `app.crud:get_user_by_email` |  |
| 4 | create-item (round-1) | `app.api.routes.items:create_item` | Persisted Item is returned to the caller. | `session.refresh(item) return item` |  |  |
| 5 | login (round-2) | `app.api.routes.login:POST /api/v1/login/access-token` | POST /api/v1/login/access-token is handled by login_access_token. | `@router.post("/login/access-token")` |  |  |
| 6 | password-recovery-email (round-2) | `app.crud:get_user_by_email` | This lookup returns the user or None, letting the handler avoid leaking whether an email is registered. | `def get_user_by_email(*, session: Session, email: str) -> User \| None:` |  |  |
| 7 | password-recovery-email (round-2) | `app.api.routes.login:recover_password` | Only if a user was found does recover_password continue to token and email generation. | `if user: password_reset_token = generate_password_reset_token(email=email)` |  |  |
| 8 | password-recovery-email (round-2) | `app.api.routes.login:recover_password` | recover_password passes the built subject and html_content to send_email for delivery. | `send_email( email_to=user.email, subject=email_data.subject, html_content=email_data.html_content,` |  |  |
| 9 | reset-password (round-2) | `app.utils:verify_password_reset_token` | Invalid tokens result in None instead of an email. | `except InvalidTokenError: return None` |  |  |
| 10 | reset-password (round-2) | `app.api.routes.login:reset_password` | On success the API returns a Password updated successfully message. | `return Message(message="Password updated successfully")` | `app.crud:update_user` |  |
| 11 | delete-user (round-2) | `app.api.deps:get_current_active_superuser` | This dependency allows only an active superuser to proceed. | `if not current_user.is_superuser:` |  |  |
| 12 | admin-create-user (round-2) | `app.api.routes.users:create_user` | Handler calls generate_new_account_email to build subject and HTML content. | `email_data = generate_new_account_email(` | `app.utils:generate_new_account_email` |  |
| 13 | admin-create-user (round-2) | `app.api.routes.users:create_user` | Handler passes the generated subject and HTML content to send_email. | `send_email( email_to=user_in.email, subject=email_data.subject, html_content=email_data.html_content,` |  |  |
| 14 | first-superuser (round-2) | `app.initial_data:main` | Main is the seeding script entry point that invokes init. | `logger.info("Creating initial data") init()` |  |  |
| 15 | first-superuser (round-2) | `app.core.db:init_db` | init_db persists the first superuser via crud.create_user. | `user = crud.create_user(session=session, user_create=user_in)` | `app.crud:create_user` |  |

## The demo take

These are not eval results, but the video shows them as fixed, so they need the same read.

| # | Question | Step | Sentence | Quote | Moved from | Proves it? |
|---|---|---|---|---|---|---|
| 16 | How does a user log in? (stitched demo take) | `app.api.routes.login:login_access_token` | The handler authenticates by passing the form username as email and form password to crud.authenticate. | `session=session, email=form_data.username, password=form_data.password` | `app.crud:authenticate` |  |
| 17 | How does a user log in? (stitched demo take) | `app.crud:authenticate` | Authenticate looks up the user row by email. | `db_user = get_user_by_email(session=session, email=email)` | `app.crud:get_user_by_email` |  |
| 18 | How does a user log in? (stitched demo take) | `app.crud:authenticate` | Password verification is performed against db_user.hashed_password. | `verified, updated_password_hash = verify_password(password, db_user.hashed_password)` | `app.core.security:verify_password` |  |
| 19 | How does a user log in? (stitched demo take) | `app.crud:authenticate` | If no user exists, verification still runs against a dummy hash to avoid timing leaks. | `password verification even when user doesn't exist # This ensures the response time is similar whether or not the email exists verify_password(password, DUMMY_HASH)` | `app.core.security:verify_password` |  |
