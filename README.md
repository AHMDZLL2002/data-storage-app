# Data Storage Web Application

A full-stack web application built with Node.js, Express, and SQLite for storing and managing user data with authentication.

## Features

- **User Authentication**: Secure login system with username and password
- **Dashboard**: Main hub with options to add data, view data, and view statistics
- **Data Entry Form**: Easy-to-use form to input and categorize data
- **Data Management**: View all stored data in a table, delete entries
- **Statistics**: View total entries and category breakdown
- **Session Management**: Secure session handling and logout functionality
- **Export Data**: Export to PDF, Excel, and CSV formats
- **Change Password**: Update admin password anytime
- **Admin Panel**: Paparan ADMIN - Register new administrators and manage users

## Project Structure

```
.
├── server.js              # Express server and API endpoints
├── database.js            # SQLite database initialization
├── package.json           # Project dependencies
├── public/
│   ├── index.html         # Login page
│   ├── dashboard.html     # Dashboard page
│   ├── data-entry.html    # Data entry form page
│   └── style.css          # Shared CSS styling
└── README.md              # This file
```

## Prerequisites

- Node.js (v14 or higher)
- npm

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the application:
```bash
npm start
```

3. Open your browser and navigate to:
```
http://localhost:3000
```

## Default Credentials

- **Username**: admin
- **Password**: password123

## Usage

### Login
1. Enter username and password
2. Click "Login" to proceed to the dashboard

### Dashboard
1. **Input Data**: Navigate to the data entry form
2. **View Data**: See all your stored entries in a table
3. **Statistics**: View analytics about your data
4. **Paparan ADMIN** (Admin only): Manage system administrators

### Admin Panel (Paparan ADMIN)
*Only visible for admin user (username: admin)*

1. **Register Pentadbir Baru**: Create new administrator accounts
   - Enter username (minimum 3 characters)
   - Enter password (minimum 5 characters)
   - Click "Register Admin Baru"

2. **Senarai Pentadbir**: View all registered administrators
   - See username and registration date
   - Delete non-default admins
   - Cannot delete the default admin account

### Data Entry
1. Fill in Tarikh (Date) - Required
2. Enter Rujukan (Reference)
3. Add Dibayar Kepada (Paid To)
4. Enter Perkara (Subject) - Required
5. Add Liabiliti (Liability)
6. Enter Bayaran (Payment)
7. Enter Jumlah Bayaran (Total Payment)
8. Enter Baki (Balance)
9. Click "Save Data"

## Features Detail

### Change Password
- Click "🔐 Change Password" in dashboard
- Enter old password
- Enter new password (minimum 5 characters)
- Confirm new password
- Password updated successfully

### Export Data
- Go to "View Data" section
- Choose export format:
  - **📄 PDF**: Professional formatted table in PDF
  - **📊 Excel**: XLSX format for spreadsheet applications
  - **📋 CSV**: Comma-separated values for data analysis

## Database

The application uses SQLite with two main tables:

### Users Table
- `id`: User ID (Primary Key)
- `username`: Unique username
- `password`: User password
- `created_at`: Account creation timestamp

### Data Table
- `id`: Entry ID (Primary Key)
- `user_id`: Foreign key to users table
- `title`: Data title
- `description`: Data description
- `category`: Data category
- `created_at`: Entry creation timestamp

## API Endpoints

### Authentication
- `POST /api/login` - User login
- `POST /api/logout` - User logout
- `GET /api/user` - Get current user info

### Data Management
- `GET /api/data` - Get all user data
- `POST /api/data` - Create new data entry
- `DELETE /api/data/:id` - Delete data entry

## Security Notes

- Passwords are stored in plain text in this version (for demo purposes only)
- For production, use proper password hashing (bcrypt)
- Use HTTPS in production
- Implement CSRF protection
- Add input validation and sanitization

## Future Enhancements

- Password hashing with bcrypt
- User registration functionality
- Edit/update data entries
- Search and filter options
- Export data to CSV/PDF
- Multi-user support with permissions
- Database backups

## License

MIT License
